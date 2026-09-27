// 上下文裁剪单测：裁旧留新 + 消息结构（assistant↔tool 配对）不被破坏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, trimContext, TRIM_PLACEHOLDER } from '../src/core/trim.ts';
import type { ChatMessage } from '../src/kernel/types.ts';

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
