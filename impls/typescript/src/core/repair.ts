// 断尾修复（WP6）：轮内中断（turn.ts catch）与加载旧会话（session.ts load）
// 共用同一个纯函数，保证悬空 tool_calls 的补占位语义全项目只有一份（不变式 I2）。
// 只计算不落盘：调用方决定补出来的占位进内存、写文件还是两者都做。
import type { ChatMessage } from '../kernel/types.ts';

/** 中断占位文案：轮内断尾与加载修复必须逐字一致 */
export const INTERRUPTED_TOOL_PLACEHOLDER = '（本轮中断，未取得执行结果；请先检查实际状态）';

/**
 * 找出 from（含）之后最后一个带 tool_calls 的 assistant 消息，为其中未获
 * tool 回应的调用生成占位 tool 消息。返回补上的占位数组（不修改入参）；
 * 序列没有悬空调用时返回空数组。
 */
export function repairDanglingToolCalls(messages: ChatMessage[], from = 0): ChatMessage[] {
  const lastIndex = messages.findLastIndex(
    (message, index) => index >= from && message.role === 'assistant' && message.tool_calls?.length,
  );
  const last = messages[lastIndex];
  if (last?.role !== 'assistant' || !last.tool_calls) return [];
  const answered = new Set(
    messages.slice(lastIndex + 1).filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
  );
  return last.tool_calls
    .filter((tc) => !answered.has(tc.id))
    .map((tc) => ({ role: 'tool' as const, tool_call_id: tc.id, content: INTERRUPTED_TOOL_PLACEHOLDER }));
}
