// 轮内中间件契约（ADR-003/WP0）：本文件只提交类型与直通组合器，不改任何行为。
// WP1 在这里实现洋葱组合、权限最内层断言与 assertInvariants。
// 设计约束（01-目标架构）：中间件不进 Registry，由 turn 固定顺序组装；
// 权限闸门固定在最内层；钩子只拿受控的 TurnState，改写消息必须走 replaceMessages。
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
 * wrapToolCall 洋葱组合（外层最先进、最后出）。实现见 WP1。
 */
export interface TurnMiddleware {
  name: string;
  beforeModel?(state: TurnState): Promise<Jump>;
  afterModel?(state: TurnState, result: CompletionResult): Promise<Jump>;
  wrapToolCall?(call: ParsedToolCall, state: TurnState, next: () => Promise<ToolOutcome>): Promise<ToolOutcome>;
}

/**
 * WP0 直通实现：按数组顺序顺序调用各钩子，不改变任何现有行为。
 * WP1 实现：洋葱组合 + "权限闸门必须最内层"的注册时断言（spec agent-loop R9）。
 */
export function composeMiddleware(middlewares: TurnMiddleware[]): TurnMiddleware {
  return {
    name: middlewares.map((m) => m.name).join('>') || 'noop',
    async beforeModel(state) {
      for (const m of middlewares) {
        const jump = await m.beforeModel?.(state);
        if (jump) return jump;
      }
    },
    async afterModel(state, result) {
      for (const m of middlewares) {
        const jump = await m.afterModel?.(state, result);
        if (jump) return jump;
      }
    },
    async wrapToolCall(call, state, next) {
      // 从最后一个中间件向内包裹，数组首个 = 最外层
      const dispatch = (i: number): Promise<ToolOutcome> =>
        i >= middlewares.length ? next() : (middlewares[i].wrapToolCall?.(call, state, () => dispatch(i + 1)) ?? dispatch(i + 1));
      return dispatch(0);
    },
  };
}

/**
 * 消息完整性不变式校验（01-目标架构 §3）。WP0 空实现，WP1 实现：
 * I1 messages[0] 永远是 system；
 * I2 每个带 tool_calls 的 assistant 消息后必须紧跟对应 id 的全部 tool 消息，不多不少；
 * I3 本轮用户消息（mark 位置）不得被删除或摘要。
 */
export function assertInvariants(_messages: readonly ChatMessage[], _mark: number): void {
  // WP1 实现
}
