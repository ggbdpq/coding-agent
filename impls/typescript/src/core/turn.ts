// 一轮用户输入的完整编排：裁剪 → 入列 → 工具循环 → 断尾修复 → 会话落盘。
// 所有壳共用这里，保证裁剪/落盘/修复语义全项目只有一份。
// v1 事件模型：turn 是唯一生产者，通过 emit 发出规范 AgentEvent（kernel/types），
// 壳只订阅不拼装——加功能=加事件类型，不动消费端接口。
// WP6 增量落盘：每产生一条消息就 append（用户消息 push 后立即写，轮内消息经
// deps.onMessage 逐条写），进程中断不再丢整轮；单条写失败由 store 静默（R6）。
import { randomUUID } from 'node:crypto';
import type { AgentEvent, ChatMessage } from '../kernel/types.ts';
import type { App } from '../kernel/app.ts';
import type { TurnMiddleware } from './middleware.ts';
import { runTurn } from './agentloop.ts';
import { compactContext } from './compact.ts';
import { repairDanglingToolCalls } from './repair.ts';
import { trimContext, estimateTokens } from './trim.ts';

export interface TurnHooks {
  /** 权限闸门（needsPermission 的工具会被询问）；缺省视为全部放行 */
  check?: (toolName: string, preview: string) => Promise<boolean>;
  signal?: AbortSignal;
  /** 规范事件出口：壳渲染（REPL 直写/web 转 SSE）、审计与测试断言都消费它 */
  emit: (ev: AgentEvent) => void;
  /** WP1：轮内用户中间件（外→内）；组合顺序固定 planMode → 用户中间件 → permission */
  middleware?: TurnMiddleware[];
}

export async function runUserTurn(app: App, line: string, hooks: TurnHooks): Promise<void> {
  const emit = (ev: AgentEvent) => hooks.emit(ev);
  emit({ type: 'turn_start', id: randomUUID() });

  let reason: 'completed' | 'aborted' | 'error' = 'completed';
  let errorMessage: string | undefined;
  // 本轮用户消息在 messages 里的位置：断尾修复只看本轮（mark 之后）的 assistant
  let mark = app.messages.length;
  try {
    // 轮前上下文治理：摘要失败才退裁剪；用户停止不改历史，也不追加本轮输入。
    if (estimateTokens(app.messages) > app.config.contextLimit * 0.8) {
      try {
        const { savedTokens } = await compactContext(app, {
          signal: hooks.signal,
          onUsage: (usage) => emit({ type: 'usage', ...usage }),
        });
        emit({ type: 'compact', savedTokens });
      } catch (error) {
        if (hooks.signal?.aborted || (error as Error).name === 'AbortError') throw error;
        const candidate = app.messages.map((message) => ({ ...message }));
        const cut = trimContext(candidate, app.config.contextLimit);
        if (cut.trimmed > 0) {
          app.store.checkpoint?.(candidate);
          app.messages.splice(0, app.messages.length, ...candidate);
          emit({ type: 'trimmed', count: cut.trimmed });
        }
      }
    }
    hooks.signal?.throwIfAborted();
    emit({ type: 'user', text: line });
    const userMessage: ChatMessage = { role: 'user', content: line };
    app.messages.push(userMessage);
    app.store.append(userMessage); // WP6：用户消息立即落盘，中断不丢本轮输入
    mark = app.messages.length - 1;
    await runTurn(app.messages, {
      provider: app.provider,
      tools: [...app.registry.tools(), ...(app.mcpTools?.() ?? [])],
      app,
      check: hooks.check,
      signal: hooks.signal,
      onText: (delta) => emit({ type: 'text_delta', delta }),
      onToolCall: (callId, name, args) => emit({ type: 'tool_call', call_id: callId, name, args }),
      onToolResult: (callId, name, result, ms) =>
        emit({ type: 'tool_result', call_id: callId, name, summary: result.split('\n')[0], output: result, ms }),
      onToolError: (e) => emit({ type: 'tool_error', ...e }), // WP3：参数校验失败/未知工具事件
      onEvent: (ev) => emit(ev), // WP0 补丁 2：中间件治理/限额事件（context_edit/limit 等）
      onUsage: (usage) => emit({ type: 'usage', ...usage }),
      middleware: hooks.middleware, // WP1：透传给 runTurn（固定管线见 agentloop）
      maxRounds: app.config.maxToolRounds, // WP5：轮次上限可配（缺省 40）
      onMessage: (m) => app.store.append(m), // WP6：轮内每 push 一条消息就落盘
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') reason = 'aborted';
    else {
      reason = 'error';
      errorMessage = err.message;
    }
    // 中断可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法；
    // 增量落盘下此前消息都已写盘，这里只把新补的占位逐条 append
    for (const m of repairDanglingToolCalls(app.messages, mark)) {
      app.messages.push(m);
      app.store.append(m);
    }
    emit({ type: 'turn_end', reason, error: errorMessage });
    throw e; // 展示方式是壳的事：REPL 区分中止/出错，web 转 SSE 事件
  }
  emit({ type: 'turn_end', reason: 'completed' });
}
