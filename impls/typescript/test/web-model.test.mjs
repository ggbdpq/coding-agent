// 已确认边界①②：真实 CLI/HTTP 使用保存的配置，外部模型以严格协议假端点替代。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('等待本地测试服务超时');
}

async function fixture(t, { protocol = 'openai', mode = 'ok', configured = true, missingWorkspace = false, workspace = false, apiKey = 'connection-fixture-key' } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tcode-model-check-'));
  const data = path.join(directory, 'data'); mkdirSync(data);
  if (workspace) mkdirSync(path.join(directory, 'project'));
  const requests = [];
  const provider = createServer(async (req, res) => {
    const modelsPath = protocol === 'openai' ? '/v1/models' : '/anthropic/v1/models';
    if (req.method === 'GET') {
      if (req.url !== modelsPath) { res.writeHead(404).end(); return; }
      requests.push({ headers: req.headers });
      if (mode === 'error') { res.writeHead(401).end('invalid key ' + apiKey); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'saved-model' }, { id: 'other-model' }, { id: 'saved-model' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== (protocol === 'openai' ? '/v1/chat/completions' : '/anthropic/v1/messages')) {
      res.writeHead(400).end('unexpected protocol route'); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ body: JSON.parse(raw), headers: req.headers });
    if (mode === 'error') { res.writeHead(401).end('invalid key ' + apiKey); return; }
    if (mode === 'retry' || mode === 'deadline') {
      if (mode === 'deadline' && requests.length === 2) await delay(8500);
      res.writeHead(500).end('retry fixture'); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (mode === 'hang') { res.write(': waiting\n\n'); return; }
    if (protocol === 'openai') {
      if (mode !== 'empty') send({ choices: [{ delta: { content: 'OK' } }] });
      send({ usage: { prompt_tokens: 3, completion_tokens: 1 }, choices: [] });
      res.end('data: [DONE]\n\n');
    } else {
      send({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } });
      send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } });
      send({ type: 'message_delta', usage: { output_tokens: 1 } });
      res.end('data: {"type":"message_stop"}\n\n');
    }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const configFile = path.join(data, 'config.json');
  writeFileSync(configFile, JSON.stringify(configured ? {
    apiKey, baseUrl: `http://127.0.0.1:${provider.address().port}/${protocol === 'openai' ? 'v1' : 'anthropic'}`,
    model: 'saved-model', protocol, workspace: workspace ? path.join(directory, 'project') : missingWorkspace ? path.join(directory, 'missing') : '',
  } : {}));
  const env = { ...process.env, TCODE_DATA_DIR: data, TCODE_APPROVAL: 'normal', TCODE_ALLOW_WRITE: '' };
  for (const key of ['TCODE_API_KEY', 'TCODE_BASE_URL', 'TCODE_MODEL', 'TCODE_PROTOCOL', 'TCODE_CONTEXT_LIMIT']) delete env[key];
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/tcode.js', import.meta.url)), 'web', '--desktop'], {
    cwd: directory, env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', (chunk) => output += chunk); child.stderr.on('data', (chunk) => errors += chunk);
  t.after(async () => {
    child.kill(); await Promise.race([new Promise((resolve) => child.once('close', resolve)), delay(200)]);
    provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
  });
  const url = await until(() => {
    if (child.exitCode !== null) throw new Error(`测试后端退出：${errors}`);
    return output.match(/http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]+\//)?.[0];
  });
  return { requests, configFile,
    state: async () => (await fetch(url + 'state')).json(),
    post: (route, body = {}) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    discover: async () => { const response = await fetch(url + 'model/discover'); return { status: response.status, body: await response.json().catch(() => ({})) }; },
  };
}

test('测试已保存模型连接：只发送固定探测，返回真实用量且不改变配置或会话', async (t) => {
  const h = await fixture(t);
  const config = readFileSync(h.configFile, 'utf8'), before = await h.state();
  const response = await h.post('model/test');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true); assert.ok(result.elapsedMs >= 0);
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 1 });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].headers.authorization, 'Bearer connection-fixture-key');
  assert.equal(h.requests[0].body.model, 'saved-model');
  assert.equal(h.requests[0].body.tools, undefined);
  assert.deepEqual(h.requests[0].body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
  const after = await h.state();
  assert.equal(after.currentSessionId, before.currentSessionId);
  assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.activity, before.activity);
  assert.deepEqual(after.usage, before.usage); assert.equal(after.busy, false);
  assert.equal(readFileSync(h.configFile, 'utf8'), config);
  assert.equal(JSON.stringify(result).includes('connection-fixture-key'), false);
});

test('保存的 Anthropic 配置通过正确 Messages 路径完成连接测试', async (t) => {
  const h = await fixture(t, { protocol: 'anthropic' });
  const response = await h.post('model/test');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).usage, { prompt_tokens: 3, completion_tokens: 1 });
  assert.equal(h.requests[0].headers['x-api-key'], 'connection-fixture-key');
  assert.equal(h.requests[0].body.tools, undefined);
  assert.deepEqual(h.requests[0].body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }]);
});

test('连接失败隐藏服务商回显的凭证并恢复可操作状态', async (t) => {
  const h = await fixture(t, { mode: 'error' });
  const response = await h.post('model/test');
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.match(result.error, /HTTP 401/);
  assert.equal(result.error.includes('connection-fixture-key'), false);
  assert.equal((await h.state()).busy, false);
});

test('错误正文截断前隐藏长凭证，两个协议都不能泄露前缀', async (t) => {
  const apiKey = 'long-fixture-key-' + 'x'.repeat(400);
  for (const protocol of ['openai', 'anthropic']) await t.test(protocol, async (t) => {
    const h = await fixture(t, { protocol, mode: 'error', apiKey });
    const response = await h.post('model/test');
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.error.includes(apiKey.slice(0, 120)), false, '错误不能回显长凭证的前缀');
    assert.equal(result.error.includes('[凭证已隐藏]'), true);
    assert.equal((await h.state()).busy, false);
  });
});

test('只收到用量但无文本不报告连接成功', async (t) => {
  const h = await fixture(t, { mode: 'empty' });
  const response = await h.post('model/test');
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /未返回文本/);
  assert.deepEqual((await h.state()).usage, { prompt_tokens: 0, completion_tokens: 0 });
});

test('取消挂起的连接测试，阻止并发测试和配置变更，且不改会话', async (t) => {
  const h = await fixture(t, { mode: 'hang' });
  const before = await h.state();
  const pending = h.post('model/test');
  await until(async () => (await h.state()).busy && h.requests.length);
  assert.equal((await h.post('model/test')).status, 409);
  assert.equal((await h.post('config', { model: 'must-not-save' })).status, 409);
  assert.equal((await h.post('abort')).status, 200);
  const response = await pending;
  assert.equal(response.status, 499);
  assert.match((await response.json()).error, /已取消/);
  const after = await h.state();
  assert.equal(after.busy, false);
  assert.equal(after.config.model, 'saved-model');
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.activity, before.activity);
});

test('退避期间取消连接测试立即结束且不重试', async (t) => {
  for (const protocol of ['openai', 'anthropic']) await t.test(protocol, async (t) => {
    const h = await fixture(t, { protocol, mode: 'retry' });
    const pending = h.post('model/test');
    await until(() => h.requests.length === 1);
    await delay(100);
    const started = performance.now();
    assert.equal((await h.post('abort')).status, 200);
    const response = await pending;
    assert.equal(response.status, 499);
    assert.match((await response.json()).error, /已取消/);
    assert.ok(performance.now() - started < 500, '取消后应立即结束，而不是继续等待重试退避');
    assert.equal((await h.state()).busy, false);
    assert.equal(h.requests.length, 1, '取消后不能发送下一次请求');
  });
});

test('连接测试退避中仍按十秒超时结束，服务可继续使用', async (t) => {
  const h = await fixture(t, { mode: 'deadline' });
  const started = performance.now();
  const response = await h.post('model/test');
  assert.equal(response.status, 408);
  assert.match((await response.json()).error, /超时/);
  assert.ok(performance.now() - started < 10500, '十秒超时不能等两秒退避完成才结束');
  assert.equal((await h.state()).busy, false);
  assert.equal(h.requests.length, 2);
});

test('缺少保存的模型配置时不向外部发送探测', async (t) => {
  const h = await fixture(t, { configured: false });
  const response = await h.post('model/test');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /先保存/);
  assert.equal(h.requests.length, 0);
});

test('上次项目目录已删除仍可独立测试模型连接', async (t) => {
  const h = await fixture(t, { missingWorkspace: true });
  assert.match((await h.state()).configError, /项目目录不可用/);
  assert.equal((await h.post('model/test')).status, 200);
});

test('模型发现走已保存配置：OpenAI 拉 /models，Anthropic 拉 /v1/models，凭证与版本头分别正确', async (t) => {
  for (const protocol of ['openai', 'anthropic']) await t.test(protocol, async (t) => {
    const h = await fixture(t, { protocol });
    const response = await h.discover();
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.models, ['other-model', 'saved-model'], '去重并按名称排序');
    const request = h.requests[0];
    if (protocol === 'openai') assert.equal(request.headers.authorization, 'Bearer connection-fixture-key');
    else {
      assert.equal(request.headers['x-api-key'], 'connection-fixture-key');
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
    }
  });
});

test('模型发现失败隐藏服务商回显的凭证', async (t) => {
  const h = await fixture(t, { mode: 'error' });
  const response = await h.discover();
  assert.equal(response.status, 502);
  assert.match(response.body.error, /HTTP 401/);
  assert.equal(response.body.error.includes('connection-fixture-key'), false);
});

test('缺少保存的模型配置时不做模型发现', async (t) => {
  const h = await fixture(t, { configured: false });
  const response = await h.discover();
  assert.equal(response.status, 400);
  assert.match(response.body.error, /先保存/);
  assert.equal(h.requests.length, 0);
});

test('任务运行期间模型发现被拒绝', async (t) => {
  const h = await fixture(t, { mode: 'hang', workspace: true });
  await h.post('send', { text: '挂起的任务' });
  await until(async () => (await h.state()).busy);
  assert.equal((await h.discover()).status, 409);
  assert.equal((await h.post('abort')).status, 200);
  await until(async () => !(await h.state()).busy);
});
