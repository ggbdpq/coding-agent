// 轮内上下文治理（ADR-003/WP2）：清理旧工具输出 → 压缩 → 裁剪，三步按序兜底，
// 任一步后降到阈值（context_limit × 0.8）以下即停；每步都发规范事件并携带 at。
// 两个入口共享同一套策略（governOnce）：
// - governanceMiddleware()：runTurn 每次 beforeModel（含强制总结）前执行；改写经
//   state.replaceMessages（统一校验 I1–I4 并 checkpoint），摘要走 state.callModel。
// - governTurnStart()：runUserTurn 在用户消息入列前执行（at:'turn_start'）——治理中止
//   时本轮输入不入列、不发 user 事件（锁定语义）；改写经 store.checkpoint + splice。
import type { AgentEvent, ChatMessage, CompletionResult, GovernanceAt } from '../kernel/types.ts';
import type { App } from '../kernel/app.ts';
import type { TurnMiddleware, TurnState } from './middleware.ts';
import { estimateTokens, trimContext, TRIM_PLACEHOLDER } from './trim.ts';
import { applyCompact, planCompact, requestSummary, toolNameFor, COMPACT_MIN_MESSAGES } from './compact.ts';

/** 触发阈值：估算 > contextLimit × 0.8（严格大于，与原 turn.ts 轮前检查一致） */
const THRESHOLD = 0.8;
/** 清理时保留最近多少条工具输出不动 */
const KEEP_RECENT_TOOLS = 3;
/** 同一轮最多压缩次数（含轮前那次，预算由 turn.ts 在两个入口间共享） */
export const MAX_COMPACT_PER_TURN = 2;
/** 清理占位前缀（幂等标记：已是清理占位的正文不再重复替换） */
export const CLEAR_PLACEHOLDER_PREFIX = '[已清理：';

/** 压缩预算：轮内最多 MAX_COMPACT_PER_TURN 次（按尝试计，失败也消耗，防重试风暴） */
export interface CompactBudget {
  left: number;
}

export function newCompactBudget(): CompactBudget {
  return { left: MAX_COMPACT_PER_TURN };
}

/** estimateTokens 只收可变数组类型，这里做引用级快照（不改 trim 的全局唯一估算实现） */
function est(messages: readonly ChatMessage[]): number {
  return estimateTokens([...messages]);
}

/** 步骤 1 清理：除最近 KEEP_RECENT_TOOLS 条外，tool 正文替换为占位；不动消息结构（I2/I4） */
function clearOldToolOutputs(messages: readonly ChatMessage[]): {
  next: ChatMessage[];
  cleared: number;
  savedTokens: number;
} {
  const toolIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolIndexes.push(i);
  }
  const candidates = toolIndexes.slice(0, Math.max(0, toolIndexes.length - KEEP_RECENT_TOOLS));
  const before = est(messages);
  let cleared = 0;
  const next = messages.map((m) => ({ ...m }));
  for (const i of candidates) {
    const m = next[i];
    const body = m.content ?? '';
    // 空内容无物可省（替换反而增加预算）；trim 占位与清理占位都已无正文，跳过保证幂等
    if (!body || body === TRIM_PLACEHOLDER || body.startsWith(CLEAR_PLACEHOLDER_PREFIX)) continue;
    const name = toolNameFor(messages, i) ?? '工具输出';
    m.content = `${CLEAR_PLACEHOLDER_PREFIX}${name} 输出 ${body.length} 字符，需要时重新读取]`;
    cleared++;
  }
  return { next, cleared, savedTokens: cleared > 0 ? Math.max(0, before - est(next)) : 0 };
}

/** 一次治理执行的输入输出：messages 为活引用（commit 后反映最新序列） */
interface GovernanceIO {
  messages: readonly ChatMessage[];
  limit: number;
  at: GovernanceAt;
  /** 本轮用户消息下标（I4 保护）；-1 = 轮前（用户尚未入列，无保护对象） */
  protectedUserIndex: number;
  signal?: AbortSignal;
  callModel: (msgs: ChatMessage[]) => Promise<CompletionResult>;
  /** 统一改写入口：轮前 = checkpoint+splice；轮内 = state.replaceMessages */
  commit: (next: ChatMessage[]) => void;
  emit: (ev: AgentEvent) => void;
  compactBudget: CompactBudget;
}

/** 三步策略：清理 → 压缩（预算内，失败退裁剪、中止上抛）→ 裁剪；每步后 ≤80% 即停 */
async function governOnce(io: GovernanceIO): Promise<void> {
  // 1 清理旧工具输出（零成本优先，05 R1）
  const clear = clearOldToolOutputs(io.messages);
  if (clear.cleared > 0) {
    io.commit(clear.next);
    io.emit({
      type: 'context_edit',
      strategy: 'clear_tool_outputs',
      cleared: clear.cleared,
      savedTokens: clear.savedTokens,
      at: io.at,
    });
    if (est(io.messages) <= io.limit * THRESHOLD) return;
  }
  // 2 压缩：同轮预算内才尝试；转写为空（没有可压缩内容）时跳过
  const plan = planCompact(io.messages, io.protectedUserIndex);
  if (io.compactBudget.left > 0 && io.messages.length > COMPACT_MIN_MESSAGES && plan.transcript) {
    io.compactBudget.left--;
    try {
      const before = est(io.messages);
      const summary = await requestSummary(io.callModel, plan.transcript, io.signal);
      io.commit(applyCompact(io.messages, plan, summary));
      io.emit({ type: 'compact', savedTokens: Math.max(0, before - est(io.messages)), at: io.at });
      if (est(io.messages) <= io.limit * THRESHOLD) return;
    } catch (e) {
      // 用户中止向上抛（历史未动）；其余摘要失败退裁剪兜底
      if ((e as Error).name === 'AbortError' || io.signal?.aborted) throw e;
    }
  }
  // 3 裁剪兜底：trimContext 的 limit 是 100% context_limit（spec context R3）
  const candidate = io.messages.map((m) => ({ ...m }));
  const cut = trimContext(candidate, io.limit);
  if (cut.trimmed > 0) {
    io.commit(candidate);
    io.emit({ type: 'trimmed', count: cut.trimmed, at: io.at });
  }
}

/**
 * 治理中间件（WP2）：挂进 runTurn 的 middleware 数组，在每次 provider.chat 前执行。
 * - 第 0 次 beforeModel（state.modelCalls === 0）记 at:'turn_start'，其余记 'model_call'；
 *   runUserTurn 已在用户消息入列前执行过轮前治理，故以 skipTurnStart 跳过第 0 次，
 *   直连 runTurn 的调用方（脚本/测试）不传该选项即可获得完整的轮前治理。
 * - compactBudget 跨入口共享（turn.ts 传入），保证“同一轮最多压缩 2 次”按全轮计。
 */
export function governanceMiddleware(
  options: { skipTurnStart?: boolean; compactBudget?: CompactBudget } = {}
): TurnMiddleware {
  const compactBudget = options.compactBudget ?? newCompactBudget();
  return {
    name: 'governance',
    async beforeModel(state) {
      const limit = state.app?.config.contextLimit;
      if (!limit) return;
      if (options.skipTurnStart && state.modelCalls === 0) return;
      if (est(state.messages) <= limit * THRESHOLD) return;
      const at: GovernanceAt = state.modelCalls === 0 ? 'turn_start' : 'model_call';
      await governOnce({
        messages: state.messages,
        limit,
        at,
        protectedUserIndex: state.mark,
        signal: state.signal,
        callModel: (msgs) => state.callModel(msgs),
        commit: (next) => state.replaceMessages(next),
        emit: (ev) => state.emit(ev),
        compactBudget,
      });
    },
  };
}

/**
 * 轮前治理（runUserTurn 专用，at:'turn_start'）：在用户消息入列前执行，保持既有锁定语义——
 * 治理中止/落盘失败时本轮输入不入列、不发 user 事件、不追加会话文件。
 */
export async function governTurnStart(
  app: App,
  opts: { signal?: AbortSignal; emit: (ev: AgentEvent) => void; compactBudget: CompactBudget }
): Promise<void> {
  const limit = app.config.contextLimit;
  if (est(app.messages) <= limit * THRESHOLD) return;
  await governOnce({
    messages: app.messages,
    limit,
    at: 'turn_start',
    protectedUserIndex: -1,
    signal: opts.signal,
    callModel: (msgs) => app.provider.chat(msgs, {
      signal: opts.signal,
      onUsage: (usage) => opts.emit({ type: 'usage', ...usage }),
    }),
    commit: (next) => {
      // 快照落盘失败必须在改动内存前抛出（历史不动，见 web 回归“压缩快照落盘失败”）
      app.store.checkpoint?.(next);
      app.messages.splice(0, app.messages.length, ...next);
    },
    emit: opts.emit,
    compactBudget: opts.compactBudget,
  });
}
