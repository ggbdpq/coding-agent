// 上下文压缩（蓝图 R3，v0.4 打磨；WP2 改造）：调模型把旧对话压成摘要，历史替换为
// [system, 摘要, 尾部原文]。trim（裁旧丢历史）降为压缩失败时的兜底。
// 纪律：摘要失败/中止时原 messages 原封不动——compact 永不破坏会话。
// WP2 拆出「消息序列 → 摘要输入」纯函数核心（planCompact/applyCompact/requestSummary），
// 适配两个调用方：/compact 命令与治理（core/governance.ts，经 state.callModel + replaceMessages）。
// 摘要转写保留工具信息：`[assistant 调用] <工具名> <参数前 200 字符>`、
// `[tool 结果 <工具名>] <结果前 300 字符>（共 N 字符）`，不再只写 `(tool_calls: N 个)`。
import type { App } from '../kernel/app.ts';
import type { ChatMessage, ChatOptions, CompletionResult } from '../kernel/types.ts';
import { estimateTokens } from './trim.ts';

const MIN_MESSAGES = 5; // system + 至少 4 条对话才值得压缩
const TAIL_KEEP = 4; // 保留最近多少条原文（摘要之外，任务细节不丢）
const ARGS_CLIP = 200; // 摘要转写里工具参数截断长度
const RESULT_CLIP = 300; // 摘要转写里工具结果截断长度
/** compact 准入下限（R4）：治理路径复用同一门槛 */
export const COMPACT_MIN_MESSAGES = MIN_MESSAGES;
const SUMMARY_SYSTEM = '你是会话摘要器：只输出摘要正文，用简体中文，尽量精炼。';
const SUMMARY_PROMPT = [
  '请把下面的对话历史压缩成一份简洁的任务摘要，供后续工作参考。',
  '必须保留：当前任务目标、已完成的关键步骤、重要文件路径与结论、尚未完成的事项。',
  '直接输出摘要正文，不要客套。',
].join('');

/** 尾部起点必须从 user 消息开始（配对安全：tool 不悬空、切片不打断 tool_call 配对） */
function pickTailStart(messages: readonly ChatMessage[], idealStart: number): number {
  for (let i = Math.max(1, idealStart); i < messages.length; i++) {
    if (messages[i].role === 'user') return i;
  }
  return messages.length; // 找不到 user 边界 → 不保留尾巴
}

/** 治理路径的尾部起点：从理想切点向后跳过悬空 tool——保留区以 user/assistant 开头才配对安全 */
function pickPairSafeStart(messages: readonly ChatMessage[], idealStart: number): number {
  let i = Math.max(1, idealStart);
  while (i < messages.length && messages[i].role === 'tool') i++;
  return i;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** 由对应的 assistant.tool_calls 查 tool 消息的工具名（向前找最近的调用者） */
export function toolNameFor(messages: readonly ChatMessage[], toolIndex: number): string | undefined {
  const id = messages[toolIndex]?.tool_call_id;
  if (!id) return undefined;
  for (let i = toolIndex - 1; i >= 0; i--) {
    const hit = messages[i].tool_calls?.find((c) => c.id === id);
    if (hit) return hit.function.name;
  }
  return undefined;
}

/** 摘要区渲染：工具调用/结果带工具名与截断片段，纯文本保持 `role: 内容` */
function renderSummaryRegion(messages: readonly ChatMessage[], from: number, to: number): string {
  const lines: string[] = [];
  for (let i = from; i < to; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'assistant' && m.tool_calls?.length) {
      if (m.content) lines.push(`${m.role}: ${m.content}`);
      for (const c of m.tool_calls) {
        lines.push(`[assistant 调用] ${c.function.name} ${clip(c.function.arguments || '', ARGS_CLIP)}`);
      }
      continue;
    }
    if (m.role === 'tool') {
      const body = m.content ?? '';
      const name = toolNameFor(messages, i) ?? '工具输出';
      lines.push(`[tool 结果 ${name}] ${clip(body, RESULT_CLIP)}（共 ${body.length} 字符）`);
      continue;
    }
    lines.push(`${m.role}: ${m.content ?? ''}`);
  }
  return lines.join('\n');
}

/** 压缩计划：transcript 送摘要模型；改写后 = [messages[0], 摘要, (被保护用户), ...slice(keepStart)] */
export interface CompactPlan {
  transcript: string;
  keepStart: number;
  /** 被保护的本轮用户消息下标（治理路径，I4）；-1 = 无保护（/compact 路径） */
  protectedUserIndex: number;
}

/**
 * 纯函数：消息序列 → 摘要输入与保留边界。
 * - /compact 路径（无保护用户）：摘要区 = [1, 尾部切点)，尾部从 len−TAIL_KEEP 扫到最近 user；
 * - 治理路径（protectedUserIndex ≥ 1）：本轮用户消息原位保留（I4），摘要区 = 其前的历史
 *   [1, mark) ∪ 其后超出尾部保留的完整配对 [mark+1, keepStart)，keepStart 从 len−TAIL_KEEP
 *   扫到配对安全边界（user/assistant 开头）。
 */
export function planCompact(messages: readonly ChatMessage[], protectedUserIndex = -1): CompactPlan {
  if (protectedUserIndex >= 1) {
    const keepStart = pickPairSafeStart(messages, Math.max(protectedUserIndex + 1, messages.length - TAIL_KEEP));
    const transcript = [
      renderSummaryRegion(messages, 1, protectedUserIndex),
      renderSummaryRegion(messages, protectedUserIndex + 1, keepStart),
    ].filter(Boolean).join('\n');
    return { transcript, keepStart, protectedUserIndex };
  }
  const keepStart = pickTailStart(messages, Math.max(1, messages.length - TAIL_KEEP));
  return { transcript: renderSummaryRegion(messages, 1, keepStart), keepStart, protectedUserIndex: -1 };
}

/** 纯函数：按计划与摘要正文产出改写后的消息序列（不改动入参） */
export function applyCompact(messages: readonly ChatMessage[], plan: CompactPlan, summary: string): ChatMessage[] {
  const summaryMsg: ChatMessage = {
    role: 'user',
    content: `[此前对话的摘要——当前任务以此为背景继续]\n${summary}\n[摘要结束]`,
  };
  const head = plan.protectedUserIndex >= 1
    ? [messages[0]!, summaryMsg, messages[plan.protectedUserIndex]!]
    : [messages[0]!, summaryMsg];
  return [...head, ...messages.slice(plan.keepStart)];
}

/** 调摘要模型并归一失败语义：中止转 AbortError 上抛，空摘要视为失败；成功返回摘要正文 */
export async function requestSummary(
  call: (msgs: ChatMessage[]) => Promise<CompletionResult>,
  transcript: string,
  signal?: AbortSignal
): Promise<string> {
  const summary = await call([
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: `${SUMMARY_PROMPT}\n\n--- 对话历史 ---\n${transcript}` },
  ]).then(
    (r) => r.message.content ?? '',
    (e: Error) => {
      if (signal?.aborted) {
        throw Object.assign(new Error('aborted（用户中止）'), { name: 'AbortError' });
      }
      throw e;
    }
  );
  signal?.throwIfAborted();
  if (!summary) throw new Error('模型返回了空摘要');
  return summary;
}

export interface CompactResult {
  /** 压缩前后估算 token 之差（>0 即省下的预算） */
  savedTokens: number;
}

/** /compact 命令与轮前治理共用的压缩入口：对 app.messages 就地压缩 */
export async function compactContext(
  app: App,
  opts: Pick<ChatOptions, 'signal' | 'onUsage'> = {}
): Promise<CompactResult> {
  const { messages } = app;
  if (messages.length <= MIN_MESSAGES) {
    throw new Error('对话太短，没什么可压缩的');
  }
  const before = estimateTokens(messages);
  const plan = planCompact(messages);
  const summary = await requestSummary((msgs) => app.provider.chat(msgs, opts), plan.transcript, opts.signal);

  // 成功才动历史：system + 摘要 + 尾部原文（切片点配对安全）
  const next = applyCompact(messages, plan, summary);
  app.store.checkpoint?.(next);
  messages.splice(0, messages.length, ...next);
  return { savedTokens: Math.max(0, before - estimateTokens(messages)) };
}
