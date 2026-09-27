// Plan Mode 单测：开启时写类工具被拒（引导产出计划）、读类工具不受影响、关闭恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runUserTurn } from '../src/core/turn.ts';
import { Registry } from '../src/kernel/registry.ts';
import { definePlugin } from '../src/kernel/plugin.ts';
import type { AgentEvent, ChatClient, ChatMessage } from '../src/kernel/types.ts';
import type { App } from '../src/kernel/app.ts';

function fakeApp(planOn: boolean): App {
  const writeTool = definePlugin({
    name: 'write',
    kind: 'tool',
    description: '',
    parameters: { type: 'object', properties: {} },
    needsPermission: true,
    preview: () => '',
    run: async () => '已写入',
  });
  const readTool = definePlugin({
    name: 'read',
    kind: 'tool',
    description: '',
    parameters: { type: 'object', properties: {} },
    needsPermission: false,
    preview: () => '',
    run: async () => '文件内容',
  });
  let n = 0;
  const client: ChatClient = {
    async chat(messages, opts) {
      n++;
      if (n === 1 || n === 2) {
        const useWrite = n === 1;
        void messages;
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `c${n}`,
                type: 'function',
                function: { name: useWrite ? 'write' : 'read', arguments: '{}' },
              },
            ],
          },
        };
      }
      opts?.onText?.('。');
      return { message: { role: 'assistant', content: '完成' } };
    },
  } as ChatClient;
  const app: App = {
    config: {
      apiKey: 'k', baseUrl: 'http://127.0.0.1', model: 'fake',
      contextLimit: 1_000_000, tcodeDir: '/tmp',
    },
    registry: new Registry().register(writeTool).register(readTool),
    provider: client,
    store: {
      start() {}, append() {}, listRecent: () => [], load: () => [],
    },
    yolo: { value: true },
    planMode: { value: planOn },
    messages: [],
    startSession() {},
    resetMessages() {},
  };
  return app;
}

test('Plan Mode 开启：写类工具被拒并引导产出计划，读类工具正常', async () => {
  const app = fakeApp(true);
  const events: AgentEvent[] = [];
  // 最多两轮：第一轮 write 被拒，第二轮 read 正常执行后无工具结束
  await runUserTurn(app, '做个计划', {
    emit: (e) => events.push(e),
    // 40 轮熔断不至于触发：手动两轮后由假客户端行为自然收敛不了，
    // 因此这里限制轮数——通过在读执行后中断不可行，改为直接验证前两轮事件。
    signal: undefined,
  }).catch(() => {});
  const results = events.filter(
    (e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result'
  );
  assert.ok(results.length >= 2, '应有两次工具回合');
  const writeDenied = results.find((r) => r.name === 'write');
  assert.ok(
    writeDenied && writeDenied.summary.includes('Plan Mode'),
    'write 应被 Plan Mode 拒绝'
  );
  const readOk = results.find((r) => r.name === 'read');
  assert.ok(readOk && readOk.summary.includes('文件内容'), 'read 不受影响');
});

test('Plan Mode 关闭：写类工具正常执行', async () => {
  const app = fakeApp(false);
  const events: AgentEvent[] = [];
  await runUserTurn(app, '直接写', { emit: (e) => events.push(e) });
  const writeResult = events.find(
    (e): e is Extract<AgentEvent, { type: 'tool_result' }> =>
      e.type === 'tool_result' && e.name === 'write'
  );
  assert.ok(writeResult && writeResult.summary.includes('已写入'));
});
