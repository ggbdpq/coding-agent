// 事件模型单测：turn 的规范事件序列（AgentEvent）是壳/审计/回放的公共契约。
// 锁死三件事：事件类型与顺序、turn_end 终态原因、断尾修复与事件的互不干扰。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runUserTurn } from '../src/core/turn.ts';
import { Registry } from '../src/kernel/registry.ts';
import { definePlugin } from '../src/kernel/plugin.ts';
import type { AgentEvent, ChatClient, ChatMessage, CompletionResult } from '../src/kernel/types.ts';
import type { App, SessionStoreLike } from '../src/kernel/app.ts';

/** 假会话存储：只记录 append 调用 */
function fakeStore() {
  const appended: ChatMessage[] = [];
  return {
    appended,
    start(_meta?: Record<string, unknown>) {},
    append(m: ChatMessage) {
      appended.push(m);
    },
    listRecent() {
      return [] as Array<{ file: string; mtime: number; label: string }>;
    },
    load() {
      return [] as ChatMessage[];
    },
  };
}
type FakeStore = ReturnType<typeof fakeStore>;

/** 要工具→拿到结果→出最终回答 的两段式假客户端 */
function toolThenTextClient(): ChatClient {
  return {
    async chat(messages, opts) {
      if (!messages.some((m) => m.role === 'tool')) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'fake', arguments: '{}' } },
            ],
          },
        };
      }
      opts?.onText?.('完成');
      const r: CompletionResult = { message: { role: 'assistant', content: '完成' } };
      return r;
    },
  };
}

const fakeTool = definePlugin({
  name: 'fake',
  kind: 'tool',
  description: '',
  parameters: { type: 'object', properties: {} },
  needsPermission: false,
  preview: () => '',
  run: async () => '工具结果',
});

function fakeApp(provider: ChatClient, store: FakeStore = fakeStore()): App {
  const registry = new Registry().register(fakeTool);
  return {
    config: {
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1',
      model: 'fake',
      contextLimit: 1_000_000,
      tcodeDir: '/tmp',
    },
    registry,
    provider,
    store,
    yolo: { value: true },
    planMode: { value: false },
    messages: [],
    startSession() {},
    resetMessages() {},
  };
}

test('规范序列：turn_start→user→tool_call→tool_result→text_delta→turn_end(completed)', async () => {
  const store = fakeStore();
  const app = fakeApp(toolThenTextClient(), store);
  const events: AgentEvent[] = [];
  await runUserTurn(app, '做事', { emit: (e) => events.push(e) });

  assert.deepEqual(
    events.map((e) => e.type),
    ['turn_start', 'user', 'tool_call', 'tool_result', 'text_delta', 'turn_end'],
  );
  const start = events[0];
  assert.equal(start.type === 'turn_start' && typeof start.id === 'string', true);
  const call = events.find((e) => e.type === 'tool_call');
  assert.equal(call?.type === 'tool_call' && call.call_id, 'c1');
  assert.equal(call?.type === 'tool_call' && call.name, 'fake');
  const result = events.find((e) => e.type === 'tool_result');
  assert.equal(result?.type === 'tool_result' && result.summary, '工具结果');
  const end = events[events.length - 1];
  assert.equal(end.type === 'turn_end' && end.reason, 'completed');
  // 会话落盘与事件不冲突：user + assistant + tool + assistant 四条
  assert.equal(store.appended.length, 4);
});

test('中止：provider 抛 AbortError → turn_end(aborted) 且异常上抛', async () => {
  const app = fakeApp({
    async chat() {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    },
  });
  const events: AgentEvent[] = [];
  await assert.rejects(
    runUserTurn(app, '做事', { emit: (e) => events.push(e) }),
    (e: Error) => e.name === 'AbortError',
  );
  const end = events[events.length - 1];
  assert.equal(end.type === 'turn_end' && end.reason, 'aborted');
});

test('错误：provider 抛普通错误 → turn_end(error) 携带消息', async () => {
  const app = fakeApp({
    async chat() {
      throw new Error('网络炸了');
    },
  });
  const events: AgentEvent[] = [];
  await assert.rejects(
    runUserTurn(app, '做事', { emit: (e) => events.push(e) }),
    /网络炸了/,
  );
  const end = events[events.length - 1];
  assert.equal(end.type === 'turn_end' && end.reason, 'error');
  assert.equal(end.type === 'turn_end' && end.error, '网络炸了');
});

test('断尾修复与事件互不干扰：工具已执行后中止，tool 结果仍在落盘序列里', async () => {
  let first = true;
  const store = fakeStore();
  const app = fakeApp(
    {
      async chat(messages, opts) {
        if (first) {
          first = false;
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'fake', arguments: '{}' } },
              ],
            },
          };
        }
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      },
    },
    store,
  );
  const events: AgentEvent[] = [];
  await assert.rejects(
    runUserTurn(app, '做事', { emit: (e) => events.push(e) }),
    (e: Error) => e.name === 'AbortError',
  );
  const roles = app.messages.map((m) => m.role);
  // user → assistant(tool_call) → tool → 无悬空调用
  assert.deepEqual(roles, ['user', 'assistant', 'tool']);
  assert.ok(store.appended.length >= 3, '断尾修复后的消息也应落盘');
});
