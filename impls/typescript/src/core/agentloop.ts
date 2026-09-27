// 核心循环：一轮对话 = 往传入的 messages 数组推进，直到模型不再要工具。
// 不持有全局状态，方便测试与将来换壳（REPL/TUI/单发）。
// 注意：按分层规则 loop 不插件化（Q4 决策）——它是这个项目的灵魂考点，
// 保持普通导出函数，接口化可替换但不进注册表。
import type { ChatClient, ChatMessage, ChatOptions } from '../kernel/types.ts';
import type { ToolDef } from '../kernel/plugin.ts';
import type { App } from '../kernel/app.ts';
import { toSchemas } from '../kernel/registry.ts';

/** 防失控：单轮对话最多允许的工具往返次数 */
export const MAX_TOOL_ROUNDS = 40;

export interface TurnDeps {
  provider: ChatClient;
  tools: ToolDef[];
  /** 白名单免确认（skipPermission）所需的运行环境（config.allowWriteDirs） */
  app?: App;
  /** 权限闸门（needsPermission 的工具会被询问）；缺省视为全部放行 */
  check?: (toolName: string, preview: string) => Promise<boolean>;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolCall?: (callId: string, name: string, args: Record<string, unknown>) => void;
  onToolResult?: (callId: string, name: string, result: string, ms: number) => void;
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number }) => void;
}

export async function runTurn(messages: ChatMessage[], deps: TurnDeps): Promise<void> {
  const schemas = toSchemas(deps.tools);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const opts: ChatOptions = {
      tools: schemas,
      signal: deps.signal,
      onText: deps.onText,
      onUsage: deps.onUsage,
    };
    const { message } = await deps.provider.chat(messages, opts);
    messages.push(message);
    if (!message.tool_calls?.length) return;

    for (const call of message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments || '{}');
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch {
        // 参数不是合法 JSON：不在这里报错，落下去让工具名的"错误"文本纠正模型
      }
      const tool = deps.tools.find((t) => t.name === call.function.name);
      if (!tool) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `错误：未知工具 ${call.function.name}。可用工具：${deps.tools.map((t) => t.name).join(', ')}`,
        });
        continue;
      }
      // Plan Mode（只读规划）：写类工具拒绝执行，引导模型产出计划
      if (deps.app?.planMode.value && tool.needsPermission) {
        const denyText =
          '当前处于 Plan Mode（只读规划）：禁止执行写类操作。请继续只读探索，并输出一份分步计划；完成后告知用户用 /plan 切回普通模式执行。';
        messages.push({ role: 'tool', tool_call_id: call.id, content: denyText });
        deps.onToolResult?.(call.id, tool.name, denyText, 0);
        continue;
      }
      deps.onToolCall?.(call.id, tool.name, args);

      // 白名单优先（skipPermission 声明受信）→ 闸门逐次确认
      const allowed =
        tool.needsPermission && deps.check && !tool.skipPermission?.(args, deps.app as App)
          ? await deps.check(tool.name, tool.preview(args))
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
      let result: string;
      try {
        result = await tool.run(args, deps.signal);
      } catch (e) {
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
