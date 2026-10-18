// 增量落盘与断尾修复单测（WP6）：
// ① 工具执行时抛错/中止：已产生的消息逐条已在会话文件里，中断补占位；
// ② 正常一轮结束：每条消息只落盘一次（不重复写）；
// ③ 加载以 assistant(tool_calls) 结尾、无 tool 回应的旧文件 → 自动补占位 tool 消息；
// ④ checkpoint 之后的增量消息能正确重放（既有行为回归锁）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runUserTurn } from '../src/core/turn.ts';
import { SessionStore } from '../src/core/session.ts';
import { Registry } from '../src/kernel/registry.ts';
import { definePlugin } from '../src/kernel/plugin.ts';
import type { ChatClient, ChatMessage, CompletionResult } from '../src/kernel/types.ts';
import type { App } from '../src/kernel/app.ts';

const PLACEHOLDER = '（本轮中断，未取得执行结果；请先检查实际状态）';

function workdir(): string {
  return mkdtempSync(path.join(tmpdir(), 'tcode-persist-'));
}

/** 读会话目录里唯一的 .jsonl，返回其中全部 message 行的消息 */
function fileMessages(dir: string): ChatMessage[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, '测试目录里应只有一个会话文件');
  return readFileSync(path.join(dir, files[0]), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { type?: string; message?: ChatMessage })
    .filter((o) => o.type === 'message' && o.message)
    .map((o) => o.message as ChatMessage);
}

/** 两段式假客户端：先要工具，拿到 tool 结果后出最终回答 */
function toolThenTextClient(): ChatClient {
  return {
    async chat(messages, opts) {
      if (!messages.some((m) => m.role === 'tool')) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fake', arguments: '{}' } }],
          },
        };
      }
      opts?.onText?.('完成');
      const r: CompletionResult = { message: { role: 'assistant', content: '完成' } };
      return r;
    },
  };
}

function fakeApp(provider: ChatClient, dir: string, run?: () => Promise<string>): App {
  const tool = definePlugin({
    name: 'fake',
    kind: 'tool',
    description: '',
    parameters: { type: 'object', properties: {} },
    needsPermission: false,
    preview: () => '',
    run: run ?? (async () => '工具结果\n第二行明细'),
  });
  const store = new SessionStore(dir);
  store.start({});
  return {
    config: {
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1',
      model: 'fake',
      contextLimit: 1_000_000,
      tcodeDir: '/tmp',
    },
    registry: new Registry().register(tool),
    provider,
    store,
    yolo: { value: true },
    planMode: { value: false },
    messages: [],
    startSession() {},
    resetMessages() {},
  };
}

test('工具执行中止：文件里已有用户消息与 assistant(tool_calls)，中断后补占位 tool 消息', async () => {
  const dir = workdir();
  // 工具执行瞬间快照文件状态；随后以中止收场
  let atToolRun: ChatMessage[] = [];
  const app = fakeApp({ async chat() {
    if (!atToolRun.length) {
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fake', arguments: '{}' } }],
        },
      };
    }
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  } }, dir, async () => {
    atToolRun = fileMessages(dir);
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  });
  await assert.rejects(runUserTurn(app, '做事', { emit: () => {} }), (e: Error) => e.name === 'AbortError');

  // 增量落盘的核心断言：工具开始执行时，用户消息与 assistant(tool_calls) 已在文件里
  assert.deepEqual(atToolRun.map((m) => m.role), ['user', 'assistant'], '工具执行时前两条消息应已落盘');
  // 中断收尾：文件 = user + assistant(tool_calls) + 占位 tool，各一条
  const persisted = fileMessages(dir);
  assert.deepEqual(persisted.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(persisted[2].tool_call_id, 'c1');
  assert.equal(persisted[2].content, PLACEHOLDER);
});

test('正常一轮结束：文件中每条消息只出现一次', async () => {
  const dir = workdir();
  const app = fakeApp(toolThenTextClient(), dir);
  await runUserTurn(app, '做事', { emit: () => {} });

  const persisted = fileMessages(dir);
  assert.deepEqual(persisted.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(persisted[0].content, '做事');
  assert.equal(persisted[2].content, '工具结果\n第二行明细');
  assert.equal(persisted[3].content, '完成');
  const keys = persisted.map((m) => JSON.stringify(m));
  assert.equal(new Set(keys).size, keys.length, '每条消息只落盘一次，不得重复写');
});

test('加载断尾文件：末尾 assistant(tool_calls) 无回应 → load 后补占位 tool 消息', () => {
  const dir = workdir();
  const store = new SessionStore(dir);
  const file = path.join(dir, 'dangling.jsonl');
  const lines = [
    JSON.stringify({ type: 'meta', ts: 1 }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: '做事' } }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'fake', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'fake', arguments: '{}' } },
        ],
      },
    }),
  ];
  writeFileSync(file, lines.join('\n') + '\n');

  const loaded = store.load(file);
  assert.deepEqual(loaded.map((m) => m.role), ['user', 'assistant', 'tool', 'tool'], '悬空调用必须逐个补占位');
  assert.deepEqual(loaded.slice(-2).map((m) => m.tool_call_id), ['c1', 'c2']);
  for (const m of loaded.slice(-2)) assert.equal(m.content, PLACEHOLDER);
});

test('checkpoint 之后的增量消息能正确重放（回归锁）', () => {
  const dir = workdir();
  const store = new SessionStore(dir);
  const file = path.join(dir, 'checkpointed.jsonl');
  const checkpointed: ChatMessage[] = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '旧回答' },
  ];
  const lines = [
    JSON.stringify({ type: 'meta', ts: 1 }),
    JSON.stringify({ type: 'context_checkpoint', messages: checkpointed }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: '新问题' } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: '新回答' } }),
  ];
  writeFileSync(file, lines.join('\n') + '\n');

  const loaded = store.load(file);
  assert.deepEqual(loaded, [
    ...checkpointed,
    { role: 'user', content: '新问题' },
    { role: 'assistant', content: '新回答' },
  ]);
});
