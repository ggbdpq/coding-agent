// 上下文预算：粗估 token（不引分词器依赖），超限时从最旧的工具输出裁起。
// 只动 tool 消息的 content，消息结构不动——assistant/tool_calls 与 tool 回应的
// 配对关系保持完整，后续请求对 API 依然合法。
import type { ChatMessage } from '../kernel/types.ts';

/** 保留最近多少条工具消息不动 */
const KEEP_RECENT_TOOLS = 12;
/** 裁剪占位文本（模型能看懂发生了什么） */
export const TRIM_PLACEHOLDER = '[早期工具输出已省略以释放上下文]';

/** 粗估 token：按 3 字符 ≈ 1 token 折中（英文约 4 字符/词、中文更密），另计每条固定开销 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content?.length ?? 0) + 8;
    for (const tc of m.tool_calls ?? []) {
      chars += tc.function.name.length + tc.function.arguments.length + 8;
    }
  }
  return Math.ceil(chars / 3);
}

/** 就地裁剪，返回被裁的消息条数；保留最近 KEEP_RECENT_TOOLS 条工具输出，裁完仍超限就到顶 */
export function trimContext(messages: ChatMessage[], limit: number): { trimmed: number } {
  if (estimateTokens(messages) <= limit) return { trimmed: 0 };
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolIdx.push(i);
  }
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT_TOOLS));
  let trimmed = 0;
  for (const i of candidates) {
    if (estimateTokens(messages) <= limit) break;
    const m = messages[i];
    if (m.content && m.content !== TRIM_PLACEHOLDER) {
      m.content = TRIM_PLACEHOLDER;
      trimmed++;
    }
  }
  return { trimmed };
}
