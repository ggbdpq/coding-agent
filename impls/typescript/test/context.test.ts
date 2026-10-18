// 上下文裁剪单测：裁旧留新 + 消息结构（assistant↔tool 配对）不被破坏。
// WP2 起追加轮内治理（governanceMiddleware）与轮前治理（governTurnStart）的用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { estimateTokens, trimContext, TRIM_PLACEHOLDER } from '../src/core/trim.ts';
import { runUserTurn } from '../src/core/turn.ts';
import { SessionStore } from '../src/core/session.ts';
import { definePlugin, type ToolPlugin } from '../src/kernel/plugin.ts';
import { Registry } from '../src/kernel/registry.ts';
import type { App, SessionStoreLike } from '../src/kernel/app.ts';
import type { AgentEvent, ChatClient, ChatMessage } from '../src/kernel/types.ts';

/** 构造一组 assistant(tool_call) + tool(大输出) 消息 */
function exchange(i: number, size: number): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: `c${i}`, type: 'function', function: { name: 'bash', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(size) },
  ];
}

test('估算随内容增长', () => {
  const small: ChatMessage[] = [{ role: 'user', content: 'hi' }];
  const big: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(3000) }];
  assert.ok(estimateTokens(big) > estimateTokens(small) * 100);
});

test('不超限时不裁任何内容', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, ...exchange(0, 100)];
  const { trimmed } = trimContext(messages, Number.MAX_SAFE_INTEGER);
  assert.equal(trimmed, 0);
});

test('超限裁剪：旧输出变占位、最近 12 条保留、配对结构完整', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
  for (let i = 0; i < 30; i++) messages.push(...exchange(i, 3000));

  const { trimmed } = trimContext(messages, 5000);
  const tools = messages.filter((m) => m.role === 'tool');
  assert.equal(trimmed, tools.filter((m) => m.content === TRIM_PLACEHOLDER).length);
  assert.equal(trimmed, 18, '30 条工具消息，保留最近 12 条，应裁最旧 18 条');
  assert.ok(
    tools.slice(-12).every((m) => m.content !== TRIM_PLACEHOLDER),
    '最近 12 条不应被裁'
  );

  // API 合法性：每个 assistant 的 tool_call 后必须紧跟同 id 的 tool 回应
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const next = messages[i + 1];
        assert.ok(
          next && next.role === 'tool' && next.tool_call_id === tc.id,
          `消息 ${i} 的工具调用 ${tc.id} 没有紧邻回应`
        );
      }
    }
  }
});

test('重复裁剪幂等', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }];
  for (let i = 0; i < 20; i++) messages.push(...exchange(i, 3000));
  trimContext(messages, 5000);
  const { trimmed } = trimContext(messages, 5000);
  assert.equal(trimmed, 0, '占位消息不应被二次裁剪');
});

test('空内容工具输出不裁：无可省内容，替换反而增加预算', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'e', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'e', content: '' },
  ];
  for (let i = 0; i < 30; i++) messages.push(...exchange(i, 3000));

  const { trimmed } = trimContext(messages, 5000);
  assert.equal(trimmed, 18, '只裁 30 条大输出中最旧 18 条，空内容不计');
  const empty = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'e');
  assert.equal(empty?.content, '', '空内容 tool 消息不应被替换');
});

// —— WP2 轮内上下文治理（04 §2：① 预算 ② 不调摘要 ③ 摘要输入 ④ 事件 ⑤ 持久化一致）——

const BIG_RESULT = 'x'.repeat(60_000);

function readTool(result: string = BIG_RESULT): ToolPlugin {
  return definePlugin({
    name: 'read',
    kind: 'tool',
    description: '',
    parameters: {},
    needsPermission: false,
    preview: () => '',
    run: async () => result,
  });
}

function wp2App(
  contextLimit: number,
  provider: ChatClient,
  opts: { tools?: ToolPlugin[]; store?: SessionStoreLike; messages?: ChatMessage[] } = {}
): App {
  const registry = new Registry();
  for (const tool of opts.tools ?? []) registry.register(tool);
  return {
    config: {
      apiKey: 'k', baseUrl: 'http://127.0.0.1', model: 'fake',
      contextLimit, tcodeDir: '/tmp',
    },
    registry,
    provider,
    store: opts.store ?? { start() {}, append() {}, listRecent: () => [], load: () => [] },
    yolo: { value: true },
    planMode: { value: false },
    messages: opts.messages ?? [{ role: 'system', content: '系统提示' }],
    startSession() {},
    resetMessages() {},
  };
}

/** 前 rounds 次要求 read 大输出、之后给最终回答；记录每次请求峰值与摘要调用 */
function readingProvider(rounds: number, result: string = BIG_RESULT) {
  const peaks: number[] = [];
  const summaryRequests: ChatMessage[][] = [];
  let n = 0;
  const provider: ChatClient = {
    async chat(messages) {
      if (String(messages[0]?.content ?? '').includes('摘要器')) {
        summaryRequests.push([...messages]);
        return { message: { role: 'assistant', content: '这是摘要' } };
      }
      peaks.push(estimateTokens(messages));
      n++;
      if (n <= rounds) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `r${n}`, type: 'function', function: { name: 'read', arguments: '{"file_path":"big.log"}' } }],
          },
        };
      }
      return { message: { role: 'assistant', content: '完成' } };
    },
  };
  return { provider, peaks, summaryRequests };
}

test('WP2 ①：单轮 8 次读 60KB 输出，每次模型请求收到的估算都 ≤ contextLimit', async () => {
  const { provider, peaks } = readingProvider(8);
  const app = wp2App(100_000, provider, { tools: [readTool()] });
  await runUserTurn(app, 'analyze', { emit: () => {} });

  assert.equal(peaks.length, 9, '8 次工具请求 + 1 次最终回答');
  for (const peak of peaks) {
    assert.ok(peak <= 100_000, `模型请求前估算 ${peak} 超过 contextLimit(100000)——轮内治理未生效`);
  }
});

test('WP2 ②：只清理旧工具输出就降到阈值下，不调用摘要模型（轮前那次 at=turn_start）', async () => {
  const history: ChatMessage[] = [{ role: 'system', content: '系统提示' }];
  for (let i = 0; i < 5; i++) {
    history.push({ role: 'user', content: `问题 ${i}` });
    history.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `o${i}`, type: 'function', function: { name: 'read', arguments: '{"file_path":"big.log"}' } }],
    });
    history.push({ role: 'tool', tool_call_id: `o${i}`, content: BIG_RESULT });
  }
  const events: AgentEvent[] = [];
  const { provider, summaryRequests } = readingProvider(0);
  const app = wp2App(100_000, provider, { tools: [readTool()], messages: history });
  await runUserTurn(app, '分析这个', { emit: (e) => events.push(e) });

  assert.equal(summaryRequests.length, 0, '清理已足够降到 80% 以下，不得调用摘要模型');
  const edit = events.find((e) => e.type === 'context_edit') as
    | (AgentEvent & { type: 'context_edit' })
    | undefined;
  assert.ok(edit, '应发出 context_edit 事件');
  assert.equal(edit.at, 'turn_start', '轮前治理的 at 必须是 turn_start');
  assert.equal(edit.cleared, 2, '5 条旧输出保留最近 3 条，应清理 2 条');
  assert.ok(edit.savedTokens > 0);
  assert.ok(!events.some((e) => e.type === 'compact'), '未压缩不得发 compact 事件');
  const cleared = app.messages.find((m) => m.role === 'tool' && String(m.content).startsWith('[已清理：'));
  assert.match(String(cleared?.content), /\[已清理：read 输出 60000 字符，需要时重新读取\]/);
  const kept = app.messages.find((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'o0');
  assert.equal(kept?.tool_calls?.[0]?.function.name, 'read', 'assistant 的工具名与参数必须保留');
  assert.equal(app.messages.filter((m) => m.role === 'tool').length, 5, '清理不删除消息（I4/I2 结构不动）');
});

test('WP2 ③④：轮内压缩的摘要输入包含工具名、参数与结果片段，compact 事件 at=model_call', async () => {
  const result = 'y'.repeat(30_000);
  const { provider, summaryRequests } = readingProvider(3, result);
  const events: AgentEvent[] = [];
  const app = wp2App(20_000, provider, { tools: [readTool(result)] });
  await runUserTurn(app, '分析这个', { emit: (e) => events.push(e) });

  assert.ok(summaryRequests.length >= 1, '清理无法达标时必须调用摘要模型');
  const transcript = String(summaryRequests[0]!.at(-1)?.content);
  assert.match(transcript, /\[assistant 调用\] read \{"file_path":"big\.log"\}/, '摘要输入必须含工具名与参数');
  assert.match(transcript, /\[tool 结果 read\] y{300}（共 30000 字符）/, '摘要输入必须含结果开头与总长');
  const compact = events.find((e) => e.type === 'compact') as (AgentEvent & { type: 'compact' }) | undefined;
  assert.ok(compact, '应发出 compact 事件');
  assert.equal(compact.at, 'model_call', '轮内压缩的 at 必须是 model_call');
  assert.ok(compact.savedTokens > 0);
  const turnUserIdx = app.messages.findIndex((m) => m.role === 'user' && m.content === '分析这个');
  assert.ok(turnUserIdx > 0, '本轮用户消息不得被摘要（I4）');
  assert.ok(String(app.messages[1]?.content).includes('摘要'), '旧历史已替换为摘要');
});

test('WP2 ④：轮内清理事件 context_edit 携带 strategy/cleared/savedTokens 且 at=model_call', async () => {
  const { provider } = readingProvider(8);
  const events: AgentEvent[] = [];
  const app = wp2App(100_000, provider, { tools: [readTool()] });
  await runUserTurn(app, 'analyze', { emit: (e) => events.push(e) });

  const edits = events.filter((e) => e.type === 'context_edit') as (AgentEvent & { type: 'context_edit' })[];
  assert.ok(edits.length >= 1, '8 次读大文件的轮内应发生多次清理');
  for (const e of edits) {
    assert.equal(e.strategy, 'clear_tool_outputs');
    assert.equal(e.at, 'model_call');
    assert.ok(e.cleared >= 1);
    assert.ok(e.savedTokens > 0);
  }
});

test('WP2 ⑤：轮内压缩写入 checkpoint，会话文件重载的消息序列与内存一致', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-wp2-'));
  const store = new SessionStore(path.join(dir, 'sessions'));
  store.start();
  const result = 'y'.repeat(30_000);
  const { provider } = readingProvider(3, result);
  const app = wp2App(20_000, provider, { tools: [readTool(result)], store });
  await runUserTurn(app, '分析这个', { emit: () => {} });

  const file = path.join(dir, 'sessions', store.currentId!);
  assert.ok(readFileSync(file, 'utf8').includes('context_checkpoint'), '轮内压缩必须落 checkpoint');
  assert.deepEqual(store.load(file), app.messages, '重载的消息序列必须与内存一致');
});
