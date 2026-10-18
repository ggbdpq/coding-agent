// 核心循环：一轮对话 = 往传入的 messages 数组推进，直到模型不再要工具。
// 不持有全局状态，方便测试与将来换壳（REPL/TUI/单发）。
// 注意：按分层规则 loop 不插件化（Q4 决策）——它是这个项目的灵魂考点，
// 保持普通导出函数，接口化可替换但不进注册表。
// WP1：Plan Mode 拦截与权限检查改为 runTurn 内部固定顺序的中间件
// （planMode → 用户中间件 → permission，权限闸门固定最内层、不进注册表）；
// 每次 provider.chat 前执行 beforeModel、返回后执行 afterModel（强制总结那次
// 调用前同样执行 beforeModel，spec agent-loop R2 修订）。
import { isDeepStrictEqual } from 'node:util';
import type { AgentEvent, ChatClient, ChatMessage, ChatOptions, ToolErrorKind } from '../kernel/types.ts';
import type { ToolDef } from '../kernel/plugin.ts';
import type { App } from '../kernel/app.ts';
import {
  assertInvariants,
  composeMiddleware,
  type ParsedToolCall,
  type ToolOutcome,
  type TurnMiddleware,
  type TurnState,
} from './middleware.ts';
import { parseToolArgs, toolArgsErrorText } from './toolargs.ts';
import { toSchemas } from '../kernel/registry.ts';

/** 防失控：单轮对话最多允许的工具往返次数 */
export const MAX_TOOL_ROUNDS = 40;

/** Plan Mode 拒写固定话术（spec agent-loop R6，五版逐字同文） */
const PLAN_MODE_DENY_TEXT =
  '当前处于 Plan Mode（只读规划）：禁止执行写类操作。请继续只读探索，并输出一份分步计划；完成后告知用户用 /plan 切回普通模式执行。';

/** 用户拒绝固定话术（spec agent-loop R7） */
const PERMISSION_DENY_TEXT =
  '用户拒绝了本次操作。请询问用户怎么办，或换一种方式；不要未经允许重试同样的操作。';

export interface TurnDeps {
  provider: ChatClient;
  tools: ToolDef[];
  /** 白名单免确认（skipPermission）所需的运行环境（config.allowWriteDirs） */
  app?: App;
  /** 权限闸门（needsPermission 的工具会被询问）；第三参为授权键（scoped 记忆粒度），缺省视为全部放行 */
  check?: (toolName: string, preview: string, grantKey?: string) => Promise<boolean>;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolCall?: (callId: string, name: string, args: Record<string, unknown>) => void;
  onToolResult?: (callId: string, name: string, result: string, ms: number) => void;
  /** WP3：参数校验失败/未知工具事件；发生时工具不执行、tool 消息为固定话术 */
  onToolError?: (e: { call_id: string; name: string; kind: ToolErrorKind; detail: string }) => void;
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number }) => void;
  /** ADR-003：轮内用户中间件（外→内）；组合顺序固定 planMode → 用户中间件 → permission */
  middleware?: TurnMiddleware[];
  /** WP0 契约补丁 2：中间件经 state.emit 发出的事件（context_edit/compact/trimmed/limit 等）由此到达壳 */
  onEvent?: (ev: AgentEvent) => void;
  /** WP6：每 push 一条消息就回调（增量持久化用） */
  onMessage?: (m: ChatMessage) => void;
  /** WP5：轮内工具往返上限；缺省 MAX_TOOL_ROUNDS（40）；turn 层从 config.maxToolRounds 传入 */
  maxRounds?: number;
}

export async function runTurn(messages: ChatMessage[], deps: TurnDeps): Promise<void> {
  const schemas = toSchemas(deps.tools);

  // —— 受控轮内状态（TurnState）：messages 只读视图，改写必须走 replaceMessages ——
  // 本轮用户消息：turn 在 push 用户消息之后调用 runTurn，故位于末尾（不变式 I3 的 mark）
  let mark = messages.length - 1;
  let modelCalls = 0;
  let toolCalls = 0;
  const turnUser = messages[mark]?.role === 'user' ? messages[mark] : undefined;
  const turnUserSnapshot = turnUser ? { ...turnUser } : undefined;

  // TurnState.replaceMessages（01-目标架构 §2 约束 3）：唯一的上下文改写入口。
  // I1/I4 需要"改写前"的信息，在这里比对原数组；I2/I3 交给 assertInvariants。
  const replaceMessages = (next: ChatMessage[]): void => {
    // I1：原来以 system 开头，改写后仍必须以 system 开头
    if (messages[0]?.role === 'system' && next[0]?.role !== 'system') {
      throw new Error('不变式 I1：messages[0] 必须保持 system');
    }
    // I4：本轮用户消息不得被删除或改写（按对象身份定位，容忍克隆，不容忍改内容）
    let nextMark = turnUser ? next.indexOf(turnUser) : mark;
    if (turnUser && nextMark === -1 && turnUserSnapshot) {
      nextMark = next.findIndex((m) => isDeepStrictEqual(m, turnUserSnapshot));
    }
    if (turnUser && (nextMark === -1 || !isDeepStrictEqual(next[nextMark], turnUserSnapshot))) {
      throw new Error('不变式 I4：本轮用户消息不得被删除或改写');
    }
    assertInvariants(next, nextMark);
    messages.splice(0, messages.length, ...next);
    mark = nextMark;
    deps.app?.store.checkpoint?.(next); // 不变式 I5：持久化与内存一致
  };

  const state: TurnState = {
    get messages() {
      return messages;
    },
    get mark() {
      return mark;
    },
    get modelCalls() {
      return modelCalls;
    },
    get toolCalls() {
      return toolCalls;
    },
    app: deps.app,
    signal: deps.signal,
    emit(ev: AgentEvent) {
      // 治理/限额类事件（context_edit/compact/trimmed/limit）经 deps.onEvent 到达壳（WP0 补丁 2）
      deps.onEvent?.(ev);
    },
    replaceMessages,
    async callModel(msgs) {
      // 不带工具的辅助调用（压缩摘要专用）：计入 usage；不触发钩子（调用方就是中间件，避免自递归）
      modelCalls++;
      return deps.provider.chat(msgs, { signal: deps.signal, onUsage: deps.onUsage });
    },
  };

  // —— 固定管线（loop 不插件化）：planMode → 用户中间件 → permission（最内层）——
  const findTool = (name: string): ToolDef | undefined => deps.tools.find((t) => t.name === name);

  const planModeMiddleware: TurnMiddleware = {
    name: 'planMode',
    wrapToolCall(call, _state, next) {
      const tool = findTool(call.name);
      // Plan Mode（只读规划）：写类工具拒绝执行，引导模型产出计划
      //（R6：判定在 preview、白名单、权限闸门之前——不执行、不询问、不算工具次数）
      if (deps.app?.planMode.value && tool?.needsPermission) {
        return Promise.resolve({ content: PLAN_MODE_DENY_TEXT, status: 'blocked', ms: 0 });
      }
      return next();
    },
  };

  const permissionMiddleware: TurnMiddleware = {
    name: 'permission',
    async wrapToolCall(call, _state, next) {
      const tool = findTool(call.name);
      if (!tool) return next();
      // 白名单优先（skipPermission 声明受信）→ 闸门逐次确认。
      // 授权键（WP4）：工具声明 grantKey 就用它的返回值（复合 bash 命令返回空 = 不可 scoped）；
      // 未声明才兜底用工具名。两种情况不能合并成 `grantKey?.() ?? name`，否则复合命令会被兜底成可 scoped。
      const grantKey = tool.grantKey ? tool.grantKey(call.args) : tool.name;
      const allowed =
        tool.needsPermission && deps.check && !tool.skipPermission?.(call.args, deps.app as App)
          ? await deps.check(tool.name, tool.preview(call.args), grantKey)
          : true;
      if (!allowed) return { content: PERMISSION_DENY_TEXT, status: 'denied', ms: 0 };
      return next();
    },
  };

  const mw = composeMiddleware([planModeMiddleware, ...(deps.middleware ?? []), permissionMiddleware]);

  // 真正的工具执行（洋葱最内层）：异常折叠为「错误：」文本回流，不中断本轮
  const executeTool = async (call: ParsedToolCall): Promise<ToolOutcome> => {
    const tool = findTool(call.name)!; // 能走到这里说明 parseToolArgs 已按名找到工具
    const t0 = Date.now();
    deps.signal?.throwIfAborted();
    try {
      const result = await tool.run(call.args, deps.signal);
      return { content: result, status: 'ok', ms: Date.now() - t0 };
    } catch (e) {
      deps.signal?.throwIfAborted();
      if ((e as Error).name === 'AbortError') throw e;
      return { content: `错误：${(e as Error).message}`, status: 'error', ms: Date.now() - t0 };
    }
  };

  // WP5：轮次上限可配（TurnDeps.maxRounds / config.maxToolRounds），缺省仍 40
  const maxRounds = deps.maxRounds ?? MAX_TOOL_ROUNDS;
  // 仅循环自然耗尽（达到上界）才算熔断；中间件 jump summarize 是主动收尾，不发 limit 事件
  let summarizeByJump = false;
  for (let round = 0; round < maxRounds; round++) {
    deps.signal?.throwIfAborted();
    // jump 语义（spec R2 修订）：summarize → 跳出循环走强制总结；end → 直接结束本轮。
    // 钩子未声明时不 await：空管线的承诺拓扑与无中间件时逐位一致（不引入微任务跳变）。
    if (mw.beforeModel) {
      const jumpBefore = await mw.beforeModel(state);
      if (jumpBefore?.jumpTo === 'end') return;
      if (jumpBefore?.jumpTo === 'summarize') {
        summarizeByJump = true;
        break;
      }
    }
    const opts: ChatOptions = {
      tools: schemas,
      signal: deps.signal,
      onText: deps.onText,
      onUsage: deps.onUsage,
    };
    const { message, finishReason } = await deps.provider.chat(messages, opts);
    modelCalls++;
    deps.signal?.throwIfAborted();
    messages.push(message);
    deps.onMessage?.(message);
    if (mw.afterModel) {
      const jumpAfter = await mw.afterModel(state, { message, finishReason });
      if (jumpAfter?.jumpTo === 'end') return;
      if (jumpAfter?.jumpTo === 'summarize') {
        summarizeByJump = true;
        break;
      }
    }
    if (!message.tool_calls?.length) return;

    for (const call of message.tool_calls) {
      deps.signal?.throwIfAborted();
      const tool = deps.tools.find((t) => t.name === call.function.name);
      if (!tool) {
        deps.onToolError?.({
          call_id: call.id,
          name: call.function.name,
          kind: 'unknown_tool',
          detail: `未知工具 ${call.function.name}，可用工具：${deps.tools.map((t) => t.name).join(', ')}`,
        });
        const unknownToolReply: ChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: `错误：未知工具 ${call.function.name}。可用工具：${deps.tools.map((t) => t.name).join(', ')}`,
        };
        messages.push(unknownToolReply);
        deps.onMessage?.(unknownToolReply);
        continue;
      }
      // WP3：非法/截断/缺字段的参数不再静默变 {}——不执行工具，固定话术回灌 + tool_error 事件
      const r = parseToolArgs(call.function.arguments, tool.parameters, finishReason);
      if (!r.ok) {
        const text = toolArgsErrorText(tool.name, call.function.arguments || '', r, tool.parameters);
        const invalidArgsReply: ChatMessage = { role: 'tool', tool_call_id: call.id, content: text };
        messages.push(invalidArgsReply);
        deps.onMessage?.(invalidArgsReply);
        deps.onToolError?.({ call_id: call.id, name: tool.name, kind: r.kind, detail: r.detail });
        continue;
      }
      const args = r.args;
      deps.onToolCall?.(call.id, tool.name, args);
      // WP1：Plan Mode / 权限检查经中间件洋葱（外→内），此处只按 ToolOutcome 归一落账
      const parsed: ParsedToolCall = { call, name: tool.name, args };
      const outcome = await (mw.wrapToolCall
        ? mw.wrapToolCall(parsed, state, () => executeTool(parsed))
        : executeTool(parsed));
      if (outcome.status === 'denied') {
        const denialReply: ChatMessage = { role: 'tool', tool_call_id: call.id, content: outcome.content };
        messages.push(denialReply);
        deps.onMessage?.(denialReply);
        deps.onToolResult?.(call.id, tool.name, '（用户已拒绝）', 0);
        continue;
      }
      if (outcome.status === 'blocked') {
        const blockedReply: ChatMessage = { role: 'tool', tool_call_id: call.id, content: outcome.content };
        messages.push(blockedReply);
        deps.onMessage?.(blockedReply);
        deps.onToolResult?.(call.id, tool.name, outcome.content, 0);
        continue;
      }
      const toolReply: ChatMessage = { role: 'tool', tool_call_id: call.id, content: outcome.content };
      messages.push(toolReply);
      deps.onMessage?.(toolReply);
      deps.onToolResult?.(call.id, tool.name, outcome.content, outcome.ms);
      toolCalls++; // denied/blocked 不计入
    }
  }

  // 轮次熔断（WP5）：达到上界先发 limit 事件（中间件 jump 主动收尾不算超限，不发），
  // 再走 beforeModel（R2 修订：总结调用同样过治理钩子），最后不带工具再要一次总结。
  if (!summarizeByJump) {
    deps.onEvent?.({ type: 'limit', kind: 'model_calls', limit: maxRounds, behavior: 'summarize' });
  }
  if (mw.beforeModel) {
    const jumpSummary = await mw.beforeModel(state);
    if (jumpSummary?.jumpTo === 'end') return;
  }
  const { message } = await deps.provider.chat(messages, {
    signal: deps.signal,
    onText: deps.onText,
    onUsage: deps.onUsage,
  });
  modelCalls++;
  messages.push(message);
  deps.onMessage?.(message);
}
