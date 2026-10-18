// 核心循环：一轮对话 = 往传入的 messages 数组推进，直到模型不再要工具。
// 不持有全局状态，方便测试与将来换壳（REPL/TUI/单发）。
// 注意：按分层规则 loop 不插件化（Q4 决策）——它是这个项目的灵魂考点，
// 保持普通导出函数，接口化可替换但不进注册表。
import type { ChatClient, ChatMessage, ChatOptions, ToolErrorKind } from '../kernel/types.ts';
import type { ToolDef } from '../kernel/plugin.ts';
import type { App } from '../kernel/app.ts';
import type { TurnMiddleware } from './middleware.ts';
import { parseToolArgs, toolArgsErrorText } from './toolargs.ts';
import { toSchemas } from '../kernel/registry.ts';

/** 防失控：单轮对话最多允许的工具往返次数 */
export const MAX_TOOL_ROUNDS = 40;

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
  /** ADR-003：轮内中间件（外→内）；WP0 仅契约，runTurn 暂不消费（WP1 接线） */
  middleware?: TurnMiddleware[];
  /** WP6：每 push 一条消息就回调（增量持久化用）；WP0 仅契约，runTurn 暂不消费 */
  onMessage?: (m: ChatMessage) => void;
  /** WP5：轮内工具往返上限；缺省 MAX_TOOL_ROUNDS；WP0 仅契约，runTurn 暂不消费 */
  maxRounds?: number;
}

export async function runTurn(messages: ChatMessage[], deps: TurnDeps): Promise<void> {
  const schemas = toSchemas(deps.tools);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    deps.signal?.throwIfAborted();
    const opts: ChatOptions = {
      tools: schemas,
      signal: deps.signal,
      onText: deps.onText,
      onUsage: deps.onUsage,
    };
    const { message, finishReason } = await deps.provider.chat(messages, opts);
    deps.signal?.throwIfAborted();
    messages.push(message);
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
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `错误：未知工具 ${call.function.name}。可用工具：${deps.tools.map((t) => t.name).join(', ')}`,
        });
        continue;
      }
      // WP3：非法/截断/缺字段的参数不再静默变 {}——不执行工具，固定话术回灌 + tool_error 事件
      const r = parseToolArgs(call.function.arguments, tool.parameters, finishReason);
      if (!r.ok) {
        const text = toolArgsErrorText(tool.name, call.function.arguments || '', r, tool.parameters);
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
        deps.onToolError?.({ call_id: call.id, name: tool.name, kind: r.kind, detail: r.detail });
        continue;
      }
      const args = r.args;
      deps.onToolCall?.(call.id, tool.name, args);
      // Plan Mode（只读规划）：写类工具拒绝执行，引导模型产出计划
      if (deps.app?.planMode.value && tool.needsPermission) {
        const denyText =
          '当前处于 Plan Mode（只读规划）：禁止执行写类操作。请继续只读探索，并输出一份分步计划；完成后告知用户用 /plan 切回普通模式执行。';
        messages.push({ role: 'tool', tool_call_id: call.id, content: denyText });
        deps.onToolResult?.(call.id, tool.name, denyText, 0);
        continue;
      }
      // 白名单优先（skipPermission 声明受信）→ 闸门逐次确认。
      // 授权键（WP4）：工具声明 grantKey 就用它的返回值（复合 bash 命令返回空 = 不可 scoped）；
      // 未声明才兜底用工具名。两种情况不能合并成 `grantKey?.() ?? name`，否则复合命令会被兜底成可 scoped。
      const grantKey = tool.grantKey ? tool.grantKey(args) : tool.name;
      const allowed =
        tool.needsPermission && deps.check && !tool.skipPermission?.(args, deps.app as App)
          ? await deps.check(tool.name, tool.preview(args), grantKey)
          : true;
      if (!allowed) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: '用户拒绝了本次操作。请询问用户怎么办，或换一种方式；不要未经允许重试同样的操作。',
        });
        deps.onToolResult?.(call.id, tool.name, '（用户已拒绝）', 0);
        continue;
      }

      const t0 = Date.now();
      deps.signal?.throwIfAborted();
      let result: string;
      try {
        result = await tool.run(args, deps.signal);
      } catch (e) {
        deps.signal?.throwIfAborted();
        if ((e as Error).name === 'AbortError') throw e;
        result = `错误：${(e as Error).message}`;
      }
      const ms = Date.now() - t0;
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      deps.onToolResult?.(call.id, tool.name, result, ms);
    }
  }

  // 轮次熔断：不带工具再要一次总结，防止无限打转
  const { message } = await deps.provider.chat(messages, {
    signal: deps.signal,
    onText: deps.onText,
    onUsage: deps.onUsage,
  });
  messages.push(message);
}
