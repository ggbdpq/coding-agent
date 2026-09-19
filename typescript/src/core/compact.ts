// 上下文压缩（蓝图 R3，v0.4 打磨）：调当前模型把旧对话压成摘要，历史替换为
// [system, 摘要消息, 最近 4 条原文]。trim（裁旧丢历史）降级为 compact 失败时的兜底。
// 纪律：摘要失败/中止时原 messages 原封不动——compact 永不破坏会话。
import type { App } from '../kernel/app.ts';
import type { ChatMessage } from '../kernel/types.ts';

const MIN_MESSAGES = 5; // system + 至少 4 条对话才值得压缩
const TAIL_KEEP = 4; // 保留最近多少条原文（摘要之外，任务细节不丢）
const SUMMARY_PROMPT = [
  '请把下面的对话历史压缩成一份简洁的任务摘要，供后续工作参考。',
  '必须保留：当前任务目标、已完成的关键步骤、重要文件路径与结论、尚未完成的事项。',
  '直接输出摘要正文，不要客套。',
].join('');

/** 尾部起点必须从 user 消息开始（配对安全：tool 不悬空、切片不打断 tool_call 配对） */
function pickTailStart(messages: ChatMessage[], idealStart: number): number {
  for (let i = Math.max(1, idealStart); i < messages.length; i++) {
    if (messages[i].role === 'user') return i;
  }
  return messages.length; // 找不到 user 边界 → 不保留尾巴
}

export interface CompactResult {
  /** 压缩前后估算 token 之差（>0 即省下的预算） */
  savedTokens: number;
}

export async function compactContext(
  app: App,
  opts: { signal?: AbortSignal } = {}
): Promise<CompactResult> {
  const { messages } = app;
  if (messages.length <= MIN_MESSAGES) {
    throw new Error('对话太短，没什么可压缩的');
  }
  const before = estimateTokens(messages);

  const transcript = messages
    .slice(1)
    .map((m) => `${m.role}: ${m.content ?? `(tool_calls: ${m.tool_calls?.length ?? 0} 个)`}`)
    .join('\n');
  const summary = await app.provider.chat(
    [
      { role: 'system', content: '你是会话摘要器：只输出摘要正文，用简体中文，尽量精炼。' },
      { role: 'user', content: `${SUMMARY_PROMPT}\n\n--- 对话历史 ---\n${transcript}` },
    ],
    { signal: opts.signal }
  ).then(
    (r) => r.message.content,
    (e: Error) => {
      if (opts.signal?.aborted) {
        throw Object.assign(new Error('aborted（用户中止）'), { name: 'AbortError' });
      }
      throw e;
    }
  );
  if (!summary) throw new Error('模型返回了空摘要');

  // 成功才动历史：system + 摘要 + 最近 TAIL_KEEP 条原文（切片点配对安全）
  const tailStart = pickTailStart(messages, Math.max(1, messages.length - TAIL_KEEP));
  const summaryMsg: ChatMessage = {
    role: 'user',
    content: `[此前对话的摘要——当前任务以此为背景继续]\n${summary}\n[摘要结束]`,
  };
  messages.splice(1, tailStart - 1, summaryMsg);
  return { savedTokens: Math.max(0, before - estimateTokens(messages)) };
}

/** 与 trim 同款粗估：ceil(字符/3)+8/条 */
function estimateTokens(messages: { content?: string | null; tool_calls?: unknown[] }[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content?.length ?? 0) + 8;
    const calls = (m as { tool_calls?: Array<{ function: { arguments: string } }> }).tool_calls;
    for (const tc of calls ?? []) chars += tc.function.arguments.length + 8;
  }
  return Math.ceil(chars / 3);
}
