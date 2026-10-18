// WP5 可选工具侧限流：toolCallLimitMiddleware 达到 max 后拒绝执行并发 limit(tool_calls) 事件。
// 背景（主代理裁定）：WP5 文档原方案靠 exitBehavior 的 Jump 语义，但 wrapToolCall 无 jump
// 通道，故折中为「发事件 + 拒绝执行（status:'error' 回灌）」；默认不注册，无调用方。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../src/core/agentloop.ts';
import { toolCallLimitMiddleware } from '../src/core/limits.ts';
import { definePlugin } from '../src/kernel/plugin.ts';
import type { AgentEvent, ChatClient, ChatMessage } from '../src/kernel/types.ts';

test('toolCallLimitMiddleware：前 max 次放行，之后拒绝执行并发 limit(tool_calls) 事件', async () => {
  let ran = 0;
  const tool = definePlugin({
    name: 'fake',
    kind: 'tool',
    description: '',
    parameters: { type: 'object', properties: {} },
    needsPermission: false,
    preview: () => '',
    run: async () => {
      ran++;
      return '工具结果';
    },
  });
  let calls = 0;
  const client: ChatClient = {
    async chat() {
      calls++;
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: `c${calls}`, type: 'function', function: { name: 'fake', arguments: '{}' } }],
        },
      };
    },
  };
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: 'user', content: '做事' }];

  await runTurn(messages, {
    provider: client,
    tools: [tool],
    maxRounds: 3, // 第 3 轮触发工具限流后，循环耗尽走熔断总结
    middleware: [toolCallLimitMiddleware({ max: 2, behavior: 'end' })],
    onEvent: (e) => events.push(e),
  });

  assert.equal(ran, 2, '达到 max 后不再执行工具');
  const limit = events.find((e) => e.type === 'limit' && e.kind === 'tool_calls');
  assert.ok(limit?.type === 'limit', '应发 limit{kind:tool_calls} 事件');
  assert.equal(limit.limit, 2);
  assert.equal(limit.behavior, 'end');
  const refused = messages.filter((m) => m.role === 'tool' && String(m.content).includes('上限'));
  assert.ok(refused.length >= 1, '被拒的调用回灌说明已达上限的 tool 消息');
});
