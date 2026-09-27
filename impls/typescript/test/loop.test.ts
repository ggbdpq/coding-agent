// 工具循环单测：40 轮熔断（带工具请求次数口径、熔断后不带工具强制总结）
// + 工具异常折叠为「错误：」文本回流不中断本轮（对齐 src/core/agentloop.ts 循环契约）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runUserTurn } from '../src/core/turn.ts';
import { Registry } from '../src/kernel/registry.ts';
import { definePlugin } from '../src/kernel/plugin.ts';
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
