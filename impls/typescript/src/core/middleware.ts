// 轮内中间件（ADR-003/WP1）：固定顺序组合、洋葱 wrapToolCall 与消息完整性不变式校验。
// 设计约束（01-目标架构 §2）：中间件不进 Registry，由 turn 固定顺序组装；
// 权限闸门固定在最内层；钩子只拿受控的 TurnState，改写消息必须走 replaceMessages；
// 中间件不得调用 provider.chat 重试（需要调模型走 state.callModel）。
import type { AgentEvent, ChatMessage, CompletionResult, ToolCall } from '../kernel/types.ts';
import type { App } from '../kernel/app.ts';

/** 中间件钩子拿到的受控轮内状态：messages 只读，改写走 replaceMessages */
export interface TurnState {
  readonly messages: readonly ChatMessage[];
  /** 本轮用户消息下标（不变式 I3：不得被删除或摘要） */
  readonly mark: number;
  /** 本轮已发生的模型调用次数（含强制总结） */
  readonly modelCalls: number;
  /** 本轮已执行的工具调用次数（不含被拒绝/参数非法的） */
  readonly toolCalls: number;
  readonly app?: App;
  readonly signal?: AbortSignal;
  emit(ev: AgentEvent): void;
  /** 唯一的上下文改写入口：校验不变式 I1–I4，然后 store.checkpoint */
  replaceMessages(next: ChatMessage[]): void;
  /** 不带工具的辅助模型调用（压缩摘要专用），计入 usage */
  callModel(messages: ChatMessage[]): Promise<CompletionResult>;
}

/** beforeModel/afterModel 的短路信号：跳过本轮剩余模型调用去总结，或直接结束本轮 */
export type Jump = { jumpTo: 'summarize' | 'end' } | void;

/** 解析成功的工具调用：agentloop 把线格式 ToolCall 拆成这三份传给中间件 */
export interface ParsedToolCall {
  call: ToolCall;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolOutcome {
  /** 回灌给模型的 tool 消息正文 */
  content: string;
  /** 'denied' / 'blocked' 不计入 toolCalls */
  status: 'ok' | 'error' | 'denied' | 'blocked';
  ms: number;
}

/**
 * 轮内中间件：beforeModel/afterModel 按数组顺序调用（外→内），
 * wrapToolCall 洋葱组合（外层最先进、最后出）。
 */
export interface TurnMiddleware {
  name: string;
  beforeModel?(state: TurnState): Promise<Jump>;
  afterModel?(state: TurnState, result: CompletionResult): Promise<Jump>;
  wrapToolCall?(call: ParsedToolCall, state: TurnState, next: () => Promise<ToolOutcome>): Promise<ToolOutcome>;
}

/**
 * 组合器（WP1）：固定顺序组合，权限闸门必须最内层。
 * - 组合顺序 = 数组顺序（外→内）；runTurn 构建为 planMode → 用户中间件 → permission（spec agent-loop R9）。
 * - permission 不在最内层（05 R12：用户中间件出现在 permission 内侧 = 可绕过审批）→ 注册时抛错。
 * - beforeModel/afterModel 按顺序执行，任一返回 {jumpTo} 立即短路。
 * - wrapToolCall 用 reduceRight 从最内层向外包裹：外→内→工具→内→外。
 * - 只组合真正存在的钩子：无中间件声明某钩子时该属性为 undefined，
 *   调用方据此跳过 await——空管线不引入任何额外微任务跳变（行为与无中间件时逐位一致）。
 */
export function composeMiddleware(middlewares: TurnMiddleware[]): TurnMiddleware {
  const permissionIdx = middlewares.findIndex((m) => m.name === 'permission');
  if (permissionIdx !== -1 && permissionIdx !== middlewares.length - 1) {
    throw new Error(
      `composeMiddleware：permission 必须是最内层中间件（数组最后一位），当前位于第 ${permissionIdx} 位（spec agent-loop R9 / 05 R12）`
    );
  }
  const composed: TurnMiddleware = { name: middlewares.map((m) => m.name).join('>') || 'noop' };
  if (middlewares.some((m) => m.beforeModel)) {
    composed.beforeModel = async (state) => {
      for (const m of middlewares) {
        const jump = await m.beforeModel?.(state);
        if (jump) return jump;
      }
    };
  }
  if (middlewares.some((m) => m.afterModel)) {
    composed.afterModel = async (state, result) => {
      for (const m of middlewares) {
        const jump = await m.afterModel?.(state, result);
        if (jump) return jump;
      }
    };
  }
  if (middlewares.some((m) => m.wrapToolCall)) {
    composed.wrapToolCall = async (call, state, next) => {
      // 从最后一个中间件（最内层）向第一个（最外层）包裹，最后包上真正的工具执行
      const dispatch = middlewares.reduceRight<() => Promise<ToolOutcome>>(
        (inner, m) => () => (m.wrapToolCall ? m.wrapToolCall(call, state, inner) : inner()),
        next,
      );
      return dispatch();
    };
  }
  return composed;
}

/**
 * 消息完整性不变式校验（01-目标架构 §3）：
 * I2 每个 assistant.tool_calls 后必须紧跟对应 id 的全部 tool 消息，不多不少；
 * I3 mark 必须指向本轮用户消息。
 * I1/I4 需要"改写前"的信息，由 replaceMessages 调用方（agentloop）比对原数组后调用本函数。
 */
export function assertInvariants(messages: readonly ChatMessage[], mark: number): void {
  // I3：mark 必须指向本轮用户消息
  if (messages[mark]?.role !== 'user') {
    throw new Error(`不变式 I3：mark(${mark}) 必须指向本轮用户消息`);
  }
  // I2：每个带 tool_calls 的 assistant 消息，后面必须紧跟对应 id 的全部 tool 消息，不多不少
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const pending = new Set(m.tool_calls.map((c) => c.id));
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      const id = messages[j].tool_call_id ?? '';
      if (!pending.delete(id)) {
        throw new Error(`不变式 I2：assistant(${i}) 后存在多余或重复的 tool 消息（tool_call_id=${id}）`);
      }
      j++;
    }
    if (pending.size > 0) {
      throw new Error(`不变式 I2：assistant(${i}) 缺少对应 tool 消息（tool_call_id=${[...pending].join(', ')}）`);
    }
  }
}
