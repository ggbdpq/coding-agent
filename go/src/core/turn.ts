// 一轮用户输入的完整编排：裁剪 → 入列 → 工具循环 → 断尾修复 → 会话落盘。
// REPL 与 web 两个壳共用这里，保证裁剪/落盘/修复语义全项目只有一份。
import type { App } from '../kernel/app.ts';
import { runTurn } from './agentloop.ts';
import { trimContext } from './trim.ts';

export interface TurnHooks {
  /** 权限闸门（needsPermission 的工具会被询问）；缺省视为全部放行 */
  check?: (toolName: string, preview: string) => Promise<boolean>;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string, ms: number) => void;
  /** 上下文被裁剪时通知壳（REPL 打灰字，web 发事件） */
  onTrimmed?: (count: number) => void;
}

export async function runUserTurn(app: App, line: string, hooks: TurnHooks = {}): Promise<void> {
  // 轮前裁剪：只影响发给模型的上下文；会话文件里保留完整历史
  const cut = trimContext(app.messages, app.config.contextLimit);
  if (cut.trimmed > 0) hooks.onTrimmed?.(cut.trimmed);

  app.messages.push({ role: 'user', content: line });
  const mark = app.messages.length - 1;
  const appendSince = () => {
    for (const m of app.messages.slice(mark)) app.store.append(m);
  };

  try {
    await runTurn(app.messages, {
      provider: app.provider,
      tools: app.registry.tools(),
      check: hooks.check,
      signal: hooks.signal,
      onText: hooks.onText,
      onToolCall: hooks.onToolCall,
      onToolResult: hooks.onToolResult,
    });
  } catch (e) {
    // 中断可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法
    const last = app.messages[app.messages.length - 1];
    if (last?.role === 'assistant' && last.tool_calls) {
      const answered = new Set(app.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
      for (const tc of last.tool_calls) {
        if (!answered.has(tc.id)) {
          app.messages.push({ role: 'tool', tool_call_id: tc.id, content: '（用户中止，未执行）' });
        }
      }
    }
    appendSince();
    throw e; // 展示方式是壳的事：REPL 区分中止/出错，web 发不同事件
  }
  appendSince();
}
