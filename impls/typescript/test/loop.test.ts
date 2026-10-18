// 工具循环单测：40 轮熔断（带工具请求次数口径、熔断后不带工具强制总结）
// + 工具异常折叠为「错误：」文本回流不中断本轮（对齐 src/core/agentloop.ts 循环契约）
// + WP3 参数校验：非法/截断/缺字段参数不执行工具，固定话术回灌 + tool_error 事件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runUserTurn } from '../src/core/turn.ts';
import { runTurn } from '../src/core/agentloop.ts';
import { loadConfig } from '../src/kernel/config.ts';
import { Registry } from '../src/kernel/registry.ts';
import { definePlugin } from '../src/kernel/plugin.ts';
import type { TurnMiddleware } from '../src/core/middleware.ts';
import type { AgentEvent, ChatClient, ChatMessage } from '../src/kernel/types.ts';
import type { App } from '../src/kernel/app.ts';

function fakeApp(client: ChatClient, tools: Parameters<Registry['register']>[0][]): App {
  let registry = new Registry();
  for (const t of tools) registry = registry.register(t);
  return {
    config: {
      apiKey: 'k', baseUrl: 'http://127.0.0.1', model: 'fake',
      contextLimit: 1_000_000, tcodeDir: '/tmp',
    },
    registry,
    provider: client,
    store: { start() {}, append() {}, listRecent: () => [], load: () => [] },
    yolo: { value: true },
    planMode: { value: false },
    messages: [],
    startSession() {},
    resetMessages() {},
  };
}

const echoTool = definePlugin({
  name: 'fake',
  kind: 'tool',
  description: '',
  parameters: { type: 'object', properties: {} },
  needsPermission: false,
  preview: () => '',
  run: async () => '工具结果',
});

test('40 轮熔断：恰 40 次带工具请求 + 1 次无工具强制总结', async () => {
  let calls = 0;
  const client: ChatClient = {
    async chat(_messages, opts) {
      calls++;
      if (calls <= 40) {
        void opts;
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
      opts?.onText?.('总结');
      return { message: { role: 'assistant', content: '总结' } };
    },
  };
  const app = fakeApp(client, [echoTool]);
  const events: AgentEvent[] = [];

  await runUserTurn(app, '做事', { emit: (e) => events.push(e) });

  assert.equal(calls, 41, '40 轮带工具请求 + 1 次无工具总结');
  assert.equal(app.messages.length, 82, 'user + 40×(assistant+tool) + 总结');
  const end = events[events.length - 1];
  assert.equal(end.type === 'turn_end' && end.reason, 'completed');
});

test('工具抛错：折叠为「错误：」文本回流，本轮继续到正常收尾', async () => {
  const boom = definePlugin({
    name: 'boom',
    kind: 'tool',
    description: '',
    parameters: { type: 'object', properties: {} },
    needsPermission: false,
    preview: () => '',
    run: async () => {
      throw new Error('炸了');
    },
  });
  let calls = 0;
  const client: ChatClient = {
    async chat(messages) {
      calls++;
      if (calls === 1) {
        void messages;
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'boom', arguments: '{}' } },
            ],
          },
        };
      }
      return { message: { role: 'assistant', content: '完成' } };
    },
  };
  const app = fakeApp(client, [boom]);
  const events: AgentEvent[] = [];

  await runUserTurn(app, '做事', { emit: (e) => events.push(e) });

  const toolMsg = app.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg && String(toolMsg.content).startsWith('错误：'), '错误应折叠为工具结果文本');
  const end = events[events.length - 1];
  assert.equal(end.type === 'turn_end' && end.reason, 'completed', '工具错误不中断本轮');
});

/** WP3 用例共用的 write 工具：file_path + content 必填 */
function writeTool(onRun: () => void = () => {}) {
  return definePlugin({
    name: 'write',
    kind: 'tool',
    description: '',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
    needsPermission: false,
    preview: () => '',
    run: async () => {
      onRun();
      return '写入成功';
    },
  });
}

test('WP3 非法 JSON 参数：工具不执行，固定话术回灌 + tool_error(invalid_args)', async () => {
  let ran = 0;
  let calls = 0;
  const client: ChatClient = {
    async chat(messages) {
      calls++;
      if (calls === 1) {
        void messages;
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'write', arguments: '{"file_path":"src/a.ts","content":"export const' } },
            ],
          },
        };
      }
      return { message: { role: 'assistant', content: '完成' } };
    },
  };
  const app = fakeApp(client, [writeTool(() => ran++)]);
  const events: AgentEvent[] = [];

  await runUserTurn(app, '写文件', { emit: (e) => events.push(e) });

  assert.equal(ran, 0, '非法 JSON 参数不执行工具');
  const toolMsg = app.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '每个 tool_call 必落一条 tool 消息');
  assert.ok(String(toolMsg.content).includes('write'), '话术含工具名');
  assert.ok(String(toolMsg.content).includes('参数'), '话术含「参数」字样');
  assert.ok(String(toolMsg.content).includes('请重新生成完整'), '话术含重新生成指引');
  const te = events.find((e) => e.type === 'tool_error');
  assert.ok(te?.type === 'tool_error', '应发 tool_error 事件');
  assert.equal(te.kind, 'invalid_args');
  assert.equal(te.call_id, 'c1');
  assert.equal(te.name, 'write');
  assert.equal(events.some((e) => e.type === 'tool_call'), false, '不执行则不发 tool_call 事件');
  assert.equal(calls, 2, '回灌后本轮继续到收尾');
});

test('WP3 截断参数：finishReason=length 且 JSON 合法 → 不执行 + tool_error(truncated_args)', async () => {
  let ran = 0;
  let calls = 0;
  const client: ChatClient = {
    async chat() {
      calls++;
      if (calls === 1) {
        return {
          finishReason: 'length',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c2', type: 'function', function: { name: 'write', arguments: '{"file_path":"a.ts","content":"hi"}' } },
            ],
          },
        };
      }
      return { message: { role: 'assistant', content: '完成' } };
    },
  };
  const app = fakeApp(client, [writeTool(() => ran++)]);
  const events: AgentEvent[] = [];

  await runUserTurn(app, '写文件', { emit: (e) => events.push(e) });

  assert.equal(ran, 0, 'R5：截断响应的参数即使 JSON 合法也不执行');
  const te = events.find((e) => e.type === 'tool_error');
  assert.ok(te?.type === 'tool_error');
  assert.equal(te.kind, 'truncated_args');
  assert.equal(te.call_id, 'c2');
});

test('WP3 缺 required 字段：不执行 + tool_error(schema_mismatch)', async () => {
  let ran = 0;
  let calls = 0;
  const client: ChatClient = {
    async chat() {
      calls++;
      if (calls === 1) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c3', type: 'function', function: { name: 'write', arguments: '{"file_path":"a.ts"}' } }],
          },
        };
      }
      return { message: { role: 'assistant', content: '完成' } };
    },
  };
  const app = fakeApp(client, [writeTool(() => ran++)]);
  const events: AgentEvent[] = [];

  await runUserTurn(app, '写文件', { emit: (e) => events.push(e) });

  assert.equal(ran, 0, '缺必需字段不执行工具');
  const te = events.find((e) => e.type === 'tool_error');
  assert.ok(te?.type === 'tool_error');
  assert.equal(te.kind, 'schema_mismatch');
  const toolMsg = app.messages.find((m) => m.role === 'tool');
  assert.ok(String(toolMsg?.content).includes('content'), '话术列出缺失的必需字段');
});

test('WP3 未知工具：沿用既有出口文本，补发 tool_error(unknown_tool)', async () => {
  let calls = 0;
  const client: ChatClient = {
    async chat() {
      calls++;
      if (calls === 1) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c4', type: 'function', function: { name: 'nope', arguments: '{}' } }],
          },
        };
      }
      return { message: { role: 'assistant', content: '完成' } };
    },
  };
  const app = fakeApp(client, [writeTool()]);
  const events: AgentEvent[] = [];

  await runUserTurn(app, '做事', { emit: (e) => events.push(e) });

  const toolMsg = app.messages.find((m) => m.role === 'tool');
  assert.ok(String(toolMsg?.content).startsWith('错误：未知工具 nope'), '既有出口文本不变');
  const te = events.find((e) => e.type === 'tool_error');
  assert.ok(te?.type === 'tool_error', '补发 tool_error 事件');
  assert.equal(te.kind, 'unknown_tool');
  assert.equal(te.call_id, 'c4');
  assert.equal(te.name, 'nope');
});

// —— WP5：轮次上限可配 + limit 事件 + 强制总结调用前 beforeModel ——

/** WP5 用例共用：一直要求同一个工具的假 provider，记录每次请求是否带工具 */
function toolLoopClient(log: Array<'tools' | 'summary'>): ChatClient {
  let calls = 0;
  return {
    async chat(_messages, opts) {
      calls++;
      const withTools = (opts?.tools?.length ?? 0) > 0;
      log.push(withTools ? 'tools' : 'summary');
      if (!withTools) return { message: { role: 'assistant', content: '总结' } };
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: `c${calls}`, type: 'function', function: { name: 'fake', arguments: '{}' } }],
        },
      };
    },
  };
}

test('WP5 maxRounds=3：第 3 轮后发 limit(model_calls) 事件，最后一次请求不带工具', async () => {
  const log: Array<'tools' | 'summary'> = [];
  const client = toolLoopClient(log);
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: 'user', content: '做事' }];

  await runTurn(messages, {
    provider: client,
    tools: [echoTool],
    maxRounds: 3,
    onEvent: (e) => events.push(e),
  });

  assert.deepEqual(log, ['tools', 'tools', 'tools', 'summary'], '3 轮带工具请求 + 1 次无工具总结');
  const limit = events.find((e) => e.type === 'limit');
  assert.ok(limit?.type === 'limit', '应发 limit 事件');
  assert.equal(limit.kind, 'model_calls');
  assert.equal(limit.limit, 3);
  assert.equal(limit.behavior, 'summarize');
});

test('WP5 达到上限后、强制总结调用之前，beforeModel 被调用（记录型中间件验证顺序）', async () => {
  const log: Array<'tools' | 'summary'> = [];
  const client = toolLoopClient(log);
  const order: string[] = [];
  const recorder: TurnMiddleware = {
    name: 'recorder',
    async beforeModel() {
      order.push('beforeModel');
    },
  };
  const messages: ChatMessage[] = [{ role: 'user', content: '做事' }];

  await runTurn(messages, { provider: client, tools: [echoTool], maxRounds: 3, middleware: [recorder] });

  assert.equal(order.length, 4, '3 轮开头 + 总结前，共 4 次 beforeModel');
  assert.deepEqual(order.slice(-1), ['beforeModel'], '总结请求前最后一步是 beforeModel');
  assert.deepEqual(log.slice(-1), ['summary'], 'beforeModel 之后才是强制总结请求');
});

/** WP5 config 用例：隔离 TCODE_DATA_DIR，写入含 maxToolRounds 的 config.json */
function loadConfigWithMaxToolRounds(value: unknown): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-wp5-'));
  const payload: Record<string, unknown> = { apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'm' };
  if (value !== undefined) payload.maxToolRounds = value;
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(payload));
  const prev = process.env.TCODE_DATA_DIR;
  process.env.TCODE_DATA_DIR = dir;
  try {
    return loadConfig();
  } finally {
    if (prev === undefined) delete process.env.TCODE_DATA_DIR;
    else process.env.TCODE_DATA_DIR = prev;
  }
}

test('WP5 config.maxToolRounds：缺省 40，合法值生效，0/负数/非整数/非数字抛错含字段名', () => {
  assert.equal(loadConfigWithMaxToolRounds(undefined).maxToolRounds, 40, '缺省 40');
  assert.equal(loadConfigWithMaxToolRounds(25).maxToolRounds, 25, '合法值生效');
  for (const bad of [0, -3, 2.5, 'abc']) {
    assert.throws(
      () => loadConfigWithMaxToolRounds(bad),
      (e: Error) => e.message.includes('maxToolRounds'),
      `非法值 ${JSON.stringify(bad)} 须抛错且错误信息含字段名`
    );
  }
});
