// 工具参数校验单测（WP3）：非法/截断/缺字段的参数不再静默变 {} 执行工具。
// 覆盖：parseToolArgs 判定表、toolArgsErrorText 固定话术、双协议结束原因映射
// （映射表见 specs/provider.md「结束原因归一化（WP3 定稿）」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseToolArgs, toolArgsErrorText } from '../src/core/toolargs.ts';
import { Provider, mapOpenAiFinishReason } from '../src/providers/openai.ts';
import { AnthropicProvider, mapAnthropicStopReason } from '../src/providers/anthropic.ts';
import type { ChatMessage } from '../src/kernel/types.ts';

const writeSchema = {
  type: 'object',
  properties: { file_path: { type: 'string' }, content: { type: 'string' } },
  required: ['file_path', 'content'],
};

test('合法 JSON 且必需字段齐全 → ok', () => {
  const r = parseToolArgs('{"file_path":"a.ts","content":"hi"}', writeSchema);
  assert.deepEqual(r, { ok: true, args: { file_path: 'a.ts', content: 'hi' } });
});

test('JSON 非法（截断的字符串字面量）→ invalid_args', () => {
  const r = parseToolArgs('{"file_path":"src/a.ts","content":"export const', writeSchema);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.kind, 'invalid_args');
});

test('顶层不是对象（数组/字符串/null）→ invalid_args', () => {
  for (const raw of ['["a"]', '"text"', 'null', '42']) {
    const r = parseToolArgs(raw, writeSchema);
    assert.equal(r.ok, false, raw);
    assert.equal(r.ok ? '' : r.kind, 'invalid_args', raw);
  }
});

test('缺 required 字段 → schema_mismatch 且 detail 列出缺失字段', () => {
  const r = parseToolArgs('{"file_path":"a.ts"}', writeSchema);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.kind, 'schema_mismatch');
  assert.match(r.ok ? '' : r.detail, /content/);
});

test('required 字段 primitive 类型不符 → schema_mismatch', () => {
  const r = parseToolArgs('{"file_path":123,"content":"hi"}', writeSchema);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.kind, 'schema_mismatch');
  assert.match(r.ok ? '' : r.detail, /file_path/);
});

test('finishReason=length → truncated_args，即使 JSON 合法（R5）', () => {
  const r = parseToolArgs('{"file_path":"a.ts","content":"hi"}', writeSchema, 'length');
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.kind, 'truncated_args');
});

test('finishReason=length 且 JSON 非法 → 也是 truncated_args（截断优先）', () => {
  const r = parseToolArgs('{"file_path":"a.ts","content":"ex', writeSchema, 'length');
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.kind, 'truncated_args');
});

test('空参数视作 {}：无 required 时 ok，有 required 时 schema_mismatch', () => {
  assert.deepEqual(parseToolArgs(undefined, { type: 'object', properties: {} }), {
    ok: true,
    args: {},
  });
  const r = parseToolArgs('', writeSchema);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.kind, 'schema_mismatch');
});

test('toolArgsErrorText：含工具名、「参数」字样、必需字段列表、重新生成指引', () => {
  const r = parseToolArgs('{"file_path":"src/a.ts","content":"export const', writeSchema);
  assert.equal(r.ok, false);
  const text = toolArgsErrorText('write', '{"file_path":"src/a.ts","content":"export const', r, writeSchema);
  assert.match(text, /write/);
  assert.match(text, /参数/);
  assert.match(text, /file_path/);
  assert.match(text, /content/);
  assert.match(text, /请重新生成完整/);
  assert.match(text, /src\/a\.ts/, '含原始参数片段');
});

test('toolArgsErrorText：原始参数截断到前 200 字符', () => {
  const long = 'x'.repeat(500);
  const r = parseToolArgs(long, { type: 'object', properties: {} });
  assert.equal(r.ok, false);
  const text = toolArgsErrorText('demo', long, r, { type: 'object', properties: {} });
  assert.ok(text.includes('x'.repeat(200)));
  assert.equal(text.includes('x'.repeat(201)), false, '只保留前 200 字符');
});

test('openai finish_reason 映射表（specs/provider.md）', () => {
  const table: Array<[string | null | undefined, string]> = [
    ['stop', 'stop'],
    ['tool_calls', 'tool_calls'],
    ['function_call', 'tool_calls'],
    ['length', 'length'],
    ['content_filter', 'content_filter'],
    ['something_new', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [raw, want] of table) assert.equal(mapOpenAiFinishReason(raw), want, String(raw));
});

test('anthropic stop_reason 映射表（specs/provider.md）', () => {
  const table: Array<[string | null | undefined, string]> = [
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'length'],
    ['refusal', 'content_filter'],
    ['pause_turn', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [raw, want] of table) assert.equal(mapAnthropicStopReason(raw), want, String(raw));
});

/** 本地假 SSE 服务器：逐条 data 行回放（同 retry.test.ts 的模式） */
function sseServer(lines: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const line of lines) res.write(`data: ${line}\n\n`);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    );
  });
}

const user: ChatMessage[] = [{ role: 'user', content: 'hi' }];

test('openai 流结束取最后一个非空 finish_reason 放进 CompletionResult', async () => {
  const s = await sseServer([
    JSON.stringify({ choices: [{ delta: { content: '好' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write', arguments: '{}' } }] } }],
    }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    '[DONE]',
  ]);
  try {
    const r = await new Provider(s.url, 'k', 'm').chat(user);
    assert.equal(r.finishReason, 'length', '取最后一个非空值');
    assert.equal(r.message.tool_calls?.[0]?.function.name, 'write');
  } finally {
    await s.close();
  }
});

test('anthropic 流结束取最后一个非空 stop_reason 映射（max_tokens→length）', async () => {
  const s = await sseServer([
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'write' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.ts"}' } }),
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
    JSON.stringify({ type: 'message_stop' }),
  ]);
  try {
    const r = await new AnthropicProvider(s.url, 'k', 'm').chat(user);
    assert.equal(r.finishReason, 'length');
    assert.equal(r.message.tool_calls?.[0]?.id, 't1');
    assert.equal(r.message.tool_calls?.[0]?.function.arguments, '{"file_path":"a.ts"}');
  } finally {
    await s.close();
  }
});

test('anthropic end_turn → stop', async () => {
  const s = await sseServer([
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } }),
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    JSON.stringify({ type: 'message_stop' }),
  ]);
  try {
    const r = await new AnthropicProvider(s.url, 'k', 'm').chat(user);
    assert.equal(r.finishReason, 'stop');
    assert.equal(r.message.content, '完成');
  } finally {
    await s.close();
  }
});
