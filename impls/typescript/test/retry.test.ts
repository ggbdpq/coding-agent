// 重试纪律单测：仅首字节前可重试——429 退避后重试、流中断绝不重试、400 立即失败。
// 用本地假 SSE 服务器 + 连接计数锁死"重试次数"这个不可见行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Provider } from '../src/providers/openai.ts';

type Mode = 'interrupt' | 'rate-limit' | 'bad-request';

function startServer(mode: Mode): Promise<{
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (mode === 'interrupt') {
      // 先给一段正文再断连：流已开始，客户端读流必然报错
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
      setTimeout(() => res.destroy(), 20);
      return;
    }
    if (mode === 'rate-limit' && hits === 1) {
      res.writeHead(429).end('慢一点');
      return;
    }
    if (mode === 'rate-limit') {
      // 重试命中：给完整流
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(400).end('参数不对');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        hits: () => hits,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    );
  });
}

const messages = [{ role: 'user' as const, content: 'hi' }];

test('流中断不重试：正文已开始后断连，错误改写为不可重试且只连接一次', async () => {
  const s = await startServer('interrupt');
  try {
    const provider = new Provider(s.url, 'k', 'm');
    await assert.rejects(provider.chat(messages), /流中断/);
    assert.equal(s.hits(), 1, '流中断后绝不重试（避免内容重复）');
  } finally {
    await s.close();
  }
});

test('429 可重试：退避后重试成功，共连接两次', async () => {
  const s = await startServer('rate-limit');
  try {
    const provider = new Provider(s.url, 'k', 'm');
    const result = await provider.chat(messages);
    assert.equal(result.message.content, '你好');
    assert.equal(s.hits(), 2, '首字节前（HTTP 状态）可重试');
  } finally {
    await s.close();
  }
});

test('400 不可重试：立即失败且只连接一次', async () => {
  const s = await startServer('bad-request');
  try {
    const provider = new Provider(s.url, 'k', 'm');
    await assert.rejects(provider.chat(messages), /HTTP 400/);
    assert.equal(s.hits(), 1);
  } finally {
    await s.close();
  }
});
