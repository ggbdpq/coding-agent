// WP1 中间件骨架单测（04 §2 五用例）：① 空中间件行为逐字节不变；② beforeModel
// 在每次 provider.chat 前执行（含 40 轮熔断后的强制总结）；③ wrapToolCall 洋葱
// 顺序（外→内→工具→内→外）；④ 用户中间件出现在 permission 内侧时注册抛错；
// ⑤ replaceMessages 破坏不变式（I2 悬空 tool_calls / I1 丢 system 开头）抛错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runUserTurn } from '../src/core/turn.ts';
import { composeMiddleware, type TurnMiddleware } from '../src/core/middleware.ts';
import { Registry } from '../src/kernel/registry.ts';
import { definePlugin } from '../src/kernel/plugin.ts';
import type { AgentEvent, ChatClient, ChatMessage } from '../src/kernel/types.ts';
import type { App } from '../src/kernel/app.ts';

function fakeApp(client: ChatClient, onRun: () => void = () => {}): App {
  const echoTool = definePlugin({
    name: 'fake',
    kind: 'tool',
    description: '',
    parameters: { type: 'object', properties: {} },
    needsPermission: false,
    preview: () => '',
    run: async () => {
      onRun();
      return '工具结果';
    },
  });
  return {
    config: {
      apiKey: 'k', baseUrl: 'http://127.0.0.1', model: 'fake',
      contextLimit: 1_000_000, tcodeDir: '/tmp',
    },
    registry: new Registry().register(echoTool),
    provider: client,
    store: { start() {}, append() {}, listRecent: () => [], load: () => [] },
    yolo: { value: true },
    planMode: { value: false },
    messages: [],
    startSession() {},
    resetMessages() {},
  };
}

/** 要工具→拿到结果→出最终回答 的两段式假客户端（同 events.test.ts 剧本） */
function toolThenText(): ChatClient {
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
      return { message: { role: 'assistant', content: '完成' } };
    },
  };
}

/** 消息投影：只保留稳定字段，用于逐字节比对 */
function project(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content ?? null,
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
  }));
}

test('① deps.middleware 缺省与空数组：事件序列与消息序列与现状逐字节一致', async () => {
  const eventsNoMw: AgentEvent[] = [];
  const appNoMw = fakeApp(toolThenText());
  await runUserTurn(appNoMw, '做事', { emit: (e) => eventsNoMw.push(e) });

  const eventsEmpty: AgentEvent[] = [];
  const appEmpty = fakeApp(toolThenText());
  await runUserTurn(appEmpty, '做事', { emit: (e) => eventsEmpty.push(e), middleware: [] });

  const expectedTypes = ['turn_start', 'user', 'tool_call', 'tool_result', 'text_delta', 'turn_end'];
  assert.deepEqual(eventsNoMw.map((e) => e.type), expectedTypes);
  assert.deepEqual(eventsEmpty.map((e) => e.type), expectedTypes);
  const expectedMessages = [
    { role: 'user', content: '做事' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fake', arguments: '{}' } }],
    },
    { role: 'tool', content: '工具结果', tool_call_id: 'c1' },
    { role: 'assistant', content: '完成' },
  ];
  assert.deepEqual(project(appNoMw.messages), expectedMessages);
  assert.deepEqual(project(appEmpty.messages), expectedMessages);
});

test('② beforeModel 在每次 provider.chat 前执行（40 轮熔断 + 强制总结共 41 次）', async () => {
  let calls = 0;
  const log: string[] = [];
  const client: ChatClient = {
    async chat(_messages, opts) {
      calls++;
      log.push('model');
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
  const tracer: TurnMiddleware = {
    name: 'tracer',
    async beforeModel() {
      log.push('before');
    },
    async afterModel() {
      log.push('after');
    },
  };
  const app = fakeApp(client);
  await runUserTurn(app, '做事', { emit: () => {}, middleware: [tracer] });

  assert.equal(calls, 41, '40 轮带工具请求 + 1 次无工具强制总结');
  assert.equal(log.filter((x) => x === 'before').length, 41, 'beforeModel 次数 = 模型调用次数');
  for (let i = 0; i < log.length; i++) {
    if (log[i] === 'model') {
      assert.equal(log[i - 1], 'before', `第 ${i} 步的模型调用前没有 beforeModel`);
    }
  }
  assert.equal(log[log.length - 2], 'before', '强制总结调用前也执行 beforeModel（R2 修订）');
  assert.equal(log[log.length - 1], 'model');
});

test('③ wrapToolCall 洋葱顺序：外→内→工具→内→外', async () => {
  const log: string[] = [];
  const wrap = (tag: string): TurnMiddleware => ({
    name: tag,
    async wrapToolCall(_call, _state, next) {
      log.push(`${tag}:in`);
      const outcome = await next();
      log.push(`${tag}:out`);
      return outcome;
    },
  });
  const client = toolThenText();
  const app = fakeApp(client, () => log.push('tool'));
  await runUserTurn(app, '做事', {
    emit: () => {},
    middleware: [wrap('outer'), wrap('inner')],
  });

  assert.deepEqual(log, ['outer:in', 'inner:in', 'tool', 'inner:out', 'outer:out']);
});

test('④ 用户中间件出现在 permission 内侧：composeMiddleware 注册时抛错', () => {
  const permission: TurnMiddleware = { name: 'permission' };
  const user: TurnMiddleware = { name: 'trace' };
  assert.throws(() => composeMiddleware([permission, user]), /permission 必须是最内层/);
  assert.throws(() => composeMiddleware([{ name: 'planMode' }, permission, user]), /permission 必须是最内层/);
  // 正常顺序不抛错：permission 在数组最后一位（最内层）
  assert.doesNotThrow(() => composeMiddleware([user, permission]));
});

test('⑤ replaceMessages 破坏不变式：I2 悬空 tool_calls / I1 丢 system 开头都抛错', async (t) => {
  await t.test('I2：assistant.tool_calls 后未紧跟对应 tool 消息', async () => {
    const breaker: TurnMiddleware = {
      name: 'breaker',
      async beforeModel(state) {
        state.replaceMessages([
          ...state.messages,
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'dangling', type: 'function', function: { name: 'fake', arguments: '{}' } }],
          },
        ]);
      },
    };
    const app = fakeApp(toolThenText());
    await assert.rejects(
      runUserTurn(app, '做事', { emit: () => {}, middleware: [breaker] }),
      /不变式 I2/,
    );
  });

  await t.test('I1：原来以 system 开头，改写后必须仍以 system 开头', async () => {
    const dropper: TurnMiddleware = {
      name: 'dropper',
      async beforeModel(state) {
        state.replaceMessages(state.messages.slice(1));
      },
    };
    const app = fakeApp(toolThenText());
    app.messages.unshift({ role: 'system', content: '系统提示' });
    await assert.rejects(
      runUserTurn(app, '做事', { emit: () => {}, middleware: [dropper] }),
      /不变式 I1/,
    );
  });
});
