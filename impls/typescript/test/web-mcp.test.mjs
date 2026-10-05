// MCP 最小切片：stdio 服务器配置持久化、连接测试（initialize + tools/list）、启停与工具桥接。
// 已确认边界：真实 CLI/HTTP、真实子进程假 MCP 服务器、外部假模型端点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('等待 MCP 测试条件超时');
}

// 假 MCP 服务器：stdio 上换行分隔 JSON-RPC，提供 echo 工具
const FAKE_SERVER = `let buffer = '';
const respond = (req, result) => { if (req.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n'); };
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') respond(msg, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } });
    else if (msg.method === 'tools/list') respond(msg, { tools: [{ name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, { name: 'slow', description: '慢速工具', inputSchema: { type: 'object' } }] });
    else if (msg.method === 'tools/call') respond(msg, { content: [{ type: 'text', text: msg.params?.name === 'slow' ? 'slow done' : 'echo:' + (msg.params?.arguments?.text ?? '') }] });
    else if (msg.method === 'resources/list') respond(msg, { resources: [{ uri: 'file:///config', name: '服务配置', description: '当前配置内容' }] });
    else if (msg.method === 'resources/read') respond(msg, { contents: [{ uri: msg.params?.uri, text: '配置内容正文' }] });
    else if (msg.method === 'prompts/list') respond(msg, { prompts: [{ name: 'greet', description: '生成问候', arguments: [{ name: 'who' }] }] });
    else if (msg.method === 'prompts/get') respond(msg, { messages: [{ role: 'user', content: { type: 'text', text: '向 ' + (msg.params?.arguments?.who ?? '世界') + ' 问好' } }] });
  }
});
process.stdin.resume();
`;

async function fixture(t, { enabled = true, transport = 'stdio', trusted = false, trustedTools } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tcode-mcp-')));
  const data = path.join(root, 'data'), workspace = path.join(root, 'project');
  for (const directory of [data, workspace]) mkdirSync(directory);
  const fakeServerPath = path.join(data, 'mcp-fake.mjs');
  writeFileSync(fakeServerPath, FAKE_SERVER);
  const requests = [];
  const provider = createServer(async (req, res) => {
    if (transport === 'http' && req.method === 'POST' && req.url === '/mcp') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const msg = JSON.parse(raw);
      const respond = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
      if (msg.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-http-1' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake-http', version: '1.0.0' } } })); }
      else if (msg.method === 'tools/list') respond({ tools: [{ name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, { name: 'slow', description: '慢速工具', inputSchema: { type: 'object' } }] });
      else if (msg.method === 'tools/call') respond({ content: [{ type: 'text', text: msg.params?.name === 'slow' ? 'slow done' : 'echo:' + (msg.params?.arguments?.text ?? '') }] });
      else if (msg.method === 'resources/list') respond({ resources: [{ uri: 'file:///config', name: '服务配置', description: '当前配置内容' }] });
      else if (msg.method === 'resources/read') respond({ contents: [{ uri: msg.params?.uri, text: '配置内容正文' }] });
      else if (msg.method === 'prompts/list') respond({ prompts: [{ name: 'greet', description: '生成问候', arguments: [{ name: 'who' }] }] });
      else if (msg.method === 'prompts/get') respond({ messages: [{ role: 'user', content: { type: 'text', text: '向 ' + (msg.params?.arguments?.who ?? '世界') + ' 问好' } }] });
      else { res.writeHead(404).end(); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const user = body.messages.findLast((m) => m.role === 'user')?.content ?? '';
    const prefix = transport === 'http' ? 'mcp__httponly' : 'mcp__demo';
    const lastUserIndex = body.messages.map((m) => m.role).lastIndexOf('user');
    const toolAfterUser = body.messages.slice(lastUserIndex + 1).some((m) => m.role === 'tool');
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (user.includes('读取') && !toolAfterUser) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mcp-call-1', function: { name: `${prefix}__read_resource`, arguments: JSON.stringify({ uri: 'file:///config' }) } }] } }] });
    } else if (user.includes('提示词') && !toolAfterUser) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mcp-call-1', function: { name: `${prefix}__get_prompt`, arguments: JSON.stringify({ name: 'greet', arguments: { who: '世界' } }) } }] } }] });
    } else if (user.includes('慢') && !toolAfterUser) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mcp-call-1', function: { name: `${prefix}__slow`, arguments: JSON.stringify({}) } }] } }] });
    } else if (!hasToolResult) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mcp-call-1', function: { name: `${prefix}__echo`, arguments: JSON.stringify({ text: 'hi' }) } }] } }] });
    } else {
      send({ choices: [{ delta: { content: '工具结果已收到：' + body.messages.findLast((m) => m.role === 'tool')?.content } }] });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const configFile = path.join(data, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    apiKey: 'mcp-key', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'mcp-model',
    protocol: 'openai', contextLimit: 40000, workspace, approval: 'normal', allowWriteDirs: [workspace],
    ...(enabled ? { mcpServers: [transport === 'http'
      ? { id: 'srv-http', name: 'httponly', url: `http://127.0.0.1:${provider.address().port}/mcp`, enabled: true, ...(trusted ? { trusted: true } : {}), ...(trustedTools ? { trustedTools } : {}) }
      : { id: 'srv-demo', name: 'demo', command: process.execPath, args: [fakeServerPath], enabled: true, ...(trusted ? { trusted: true } : {}), ...(trustedTools ? { trustedTools } : {}) }] } : {}),
  }));
  const env = { ...process.env, TCODE_DATA_DIR: data };
  for (const key of ['TCODE_API_KEY', 'TCODE_BASE_URL', 'TCODE_MODEL', 'TCODE_PROTOCOL', 'TCODE_APPROVAL']) delete env[key];
  let child, url;
  async function start() {
    child = spawn(process.execPath, [fileURLToPath(new URL('../bin/tcode.js', import.meta.url)), 'web', '--desktop'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', (chunk) => output += chunk); child.stderr.on('data', (chunk) => errors += chunk);
    url = await until(() => {
      if (child.exitCode !== null) throw new Error('CLI 退出：' + errors);
      return output.match(/http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]+\//)?.[0];
    });
  }
  async function stop() { child.kill(); await Promise.race([new Promise((resolve) => child.once('close', resolve)), delay(200)]); }
  await start();
  t.after(async () => { await stop(); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); });
  const event = (type) => until(() => null, type);
  return { root, data, workspace, configFile, fakeServerPath, requests,
    state: async () => (await fetch(url + 'state')).json(),
    post: async (route, body = {}) => { const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json().catch(() => ({})) }; },
    get: async (route) => { const response = await fetch(url + route); return { status: response.status, body: await response.json().catch(() => ({})) }; },
    restart: async () => { await stop(); await start(); },
    events: () => events,
  };
}

/** 走完一轮含审批的工具调用 */
async function approvedTurn(h) {
  const mark = Date.now();
  await h.post('send', { text: '用 demo 的 echo 工具' });
  const deadline = mark + 5000;
  while (Date.now() < deadline) {
    const state = await h.state();
    const pending = state.pending?.[0];
    if (pending) {
      const allowed = await h.post('permission', { id: pending.id, decision: 'allow' });
      assert.equal(allowed.status, 200);
    }
    if (state.status === 'completed' && !state.busy) return state;
    await delay(20);
  }
  const state = await h.state();
  throw new Error('工具轮未在时限内完成：' + JSON.stringify({ status: state.status, busy: state.busy, pending: state.pending, last: state.messages.at(-1)?.content?.slice(0, 200) }));
}

test('MCP 服务器配置持久化、连接测试列出工具，重启后仍可用', async (t) => {
  const h = await fixture(t);
  const persisted = JSON.parse(readFileSync(h.configFile, 'utf8'));
  assert.equal(persisted.mcpServers[0].name, 'demo');
  assert.equal(persisted.mcpServers[0].enabled, true);
  const test = await h.post('mcp/test', { id: 'srv-demo' });
  assert.equal(test.status, 200);
  assert.deepEqual(test.body.tools.sort(), ['echo', 'slow']);
  await h.restart();
  await until(async () => (await h.state()).capabilities.tools.some((tool) => tool.name === 'mcp__demo__echo'), '重启后工具桥接');
  const state = await h.state();
  assert.equal(JSON.stringify(state).includes('automation-key'), false);
});

test('启用的 MCP 工具经审批桥接进会话并真实调用，结果回传模型', async (t) => {
  const h = await fixture(t);
  const state = await approvedTurn(h);
  assert.equal(state.capabilities.tools.some((tool) => tool.name === 'mcp__demo__echo'), true);
  assert.match(state.messages.at(-1).content, /echo:hi/, 'MCP 工具的真实返回要回传给模型');
});

test('停用后工具不再桥接，调用得到可见错误', async (t) => {
  const h = await fixture(t, { enabled: false });
  const state = await approvedTurn(h);
  assert.equal(state.capabilities.tools.some((tool) => tool.name === 'mcp__demo__echo'), false, '停用的服务器不桥接');
  assert.match(state.messages.at(-1).content, /未知工具 mcp__demo__echo/, '调用不可用工具要有明确错误');
});

test('MCP 配置 CRUD：非法输入拒绝，删除后连接测试 404', async (t) => {
  const h = await fixture(t);
  assert.equal((await h.post('mcp/servers', { name: '', command: 'node' })).status, 400);
  assert.equal((await h.post('mcp/servers', { name: 'no-cmd', command: '   ' })).status, 400);
  assert.equal((await h.post('mcp/servers', { name: 'bad args', command: 'node', args: [1, 2] })).status, 400);
  const saved = await h.post('mcp/servers', { name: 'second', command: process.execPath, args: [h.fakeServerPath], enabled: false });
  assert.equal(saved.status, 200);
  const state = await h.state();
  assert.equal(state.capabilities.tools.some((tool) => tool.name.startsWith('mcp__second__')), false, '停用的新服务器不桥接');
  assert.equal((await h.post('mcp/test', { id: 'missing' })).status, 404);
  const removed = await h.post('mcp/servers/delete', { id: 'srv-demo' });
  assert.equal(removed.status, 200);
  const after = await h.state();
  assert.equal(after.capabilities.tools.some((tool) => tool.name.startsWith('mcp__demo__')), false, '删除后工具不再桥接');
  assert.equal((await h.post('mcp/test', { id: 'srv-demo' })).status, 404);
});

test('trusted 服务器的工具免审批直接执行：无审批等待、结果照常回传、持久化', async (t) => {
  const h = await fixture(t, { transport: 'http', trusted: true });
  const mark = Date.now();
  await h.post('send', { text: '用 httponly 的 echo 工具' });
  const deadline = mark + 5000;
  while (Date.now() < deadline) {
    const state = await h.state();
    assert.deepEqual(state.pending, [], 'trusted 服务器的工具不能出现审批等待');
    if (state.status === 'completed' && !state.busy) {
      assert.match(state.messages.at(-1).content, /echo:hi/, '免审批工具的真实返回照常回传');
      const persisted = JSON.parse(readFileSync(h.configFile, 'utf8'));
      assert.equal(persisted.mcpServers[0].trusted, true, '信任标记持久化');
      await h.restart();
      assert.equal((await h.state()).capabilities.mcpServers[0].trusted, true, '重启后信任仍在');
      return;
    }
    await delay(20);
  }
  throw new Error('免审批工具轮未在时限内完成');
});

test('HTTP Streamable 传输：连接测试列出工具、桥接调用经审批回传', async (t) => {
  const h = await fixture(t, { transport: 'http' });
  await until(async () => (await h.state()).capabilities.tools.some((tool) => tool.name === 'mcp__httponly__echo'), '启动预热后 HTTP 服务器工具桥接');
  const listed = (await h.state()).capabilities.tools;
  const probe = await h.post('mcp/test', { id: 'srv-http' });
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.body.tools.sort(), ['echo', 'slow']);
  const state = await approvedTurn(h);
  assert.match(state.messages.at(-1).content, /echo:hi/, 'HTTP 工具调用结果回传模型');
  assert.equal((await h.post('mcp/servers', { name: 'bad-url', url: 'ftp://x/mcp', enabled: true })).status, 400);
});

test('trustedTools 白名单：名单内工具免审批，名单外仍逐次审批，持久化', async (t) => {
  const h = await fixture(t, { transport: 'http', trustedTools: ['echo'] });
  const persisted = JSON.parse(readFileSync(h.configFile, 'utf8'));
  assert.deepEqual(persisted.mcpServers[0].trustedTools, ['echo']);
  await until(async () => (await h.state()).capabilities.tools.some((tool) => tool.name === 'mcp__httponly__slow'), '工具桥接');

  await h.post('send', { text: '用 echo 回个话' });
  const deadline = Date.now() + 5000;
  let echoDone = false;
  while (Date.now() < deadline) {
    const state = await h.state();
    assert.deepEqual(state.pending, [], '名单内工具不能出现审批等待');
    if (state.status === 'completed' && !state.busy) { echoDone = true; break; }
    await delay(20);
  }
  assert.equal(echoDone, true, 'echo 轮完成');
  assert.match((await h.state()).messages.at(-1).content, /echo:hi/);

  await h.post('send', { text: '跑慢工具' });
  let slowApproved = false;
  const deadline2 = Date.now() + 5000;
  while (Date.now() < deadline2) {
    const state = await h.state();
    const pending = state.pending?.[0];
    if (pending) {
      slowApproved = true;
      assert.match(pending.preview, /slow/, '名单外工具的审批预览');
      await h.post('permission', { id: pending.id, decision: 'allow' });
    }
    if (state.status === 'completed' && !state.busy) break;
    await delay(20);
  }
  assert.equal(slowApproved, true, '名单外工具仍需逐次审批');
  assert.match((await h.state()).messages.at(-1).content, /slow done/);
  await h.restart();
  assert.deepEqual(JSON.parse(readFileSync(h.configFile, 'utf8')).mcpServers[0].trustedTools, ['echo'], '重启后白名单仍在');
});

test('资源与提示词桥接：聚合工具读取资源正文、获取提示词模板', async (t) => {
  const h = await fixture(t);
  await until(async () => (await h.state()).capabilities.tools.some((tool) => tool.name === 'mcp__demo__read_resource'), '资源聚合工具桥接');
  const tools = (await h.state()).capabilities.tools.map((tool) => tool.name);
  assert.equal(tools.includes('mcp__demo__get_prompt'), true, '提示词聚合工具桥接');

  await h.post('send', { text: '读取 file:///config 资源' });
  const mark = Date.now();
  while (Date.now() < mark + 5000) {
    const state = await h.state();
    const pending = state.pending?.[0];
    if (pending) await h.post('permission', { id: pending.id, decision: 'allow' });
    if (state.status === 'completed' && !state.busy) {
      assert.match(state.messages.at(-1).content, /配置内容正文/, '资源正文回传模型');
      break;
    }
    await delay(20);
  }
  await h.post('send', { text: '用 greet 提示词生成问候' });
  const mark2 = Date.now();
  while (Date.now() < mark2 + 5000) {
    const state = await h.state();
    const pending = state.pending?.[0];
    if (pending) await h.post('permission', { id: pending.id, decision: 'allow' });
    if (state.status === 'completed' && !state.busy) {
      assert.match(state.messages.at(-1).content, /向 世界 问好|向 .* 问好/, '提示词模板文本回传模型');
      return;
    }
    await delay(20);
  }
  throw new Error('提示词轮未在时限内完成');
});

test('资源与提示词清单注入系统提示词', async (t) => {
  const h = await fixture(t);
  await until(async () => (await h.state()).capabilities.tools.some((tool) => tool.name === 'mcp__demo__read_resource'), '预热完成');
  await h.post('send', { text: '随便说点什么' });
  // 第一个模型请求即可验证 system 注入（无需等轮次结束）
  await until(async () => h.requests.length > 0, '首个模型请求');
  const system = h.requests.at(-1).messages[0]?.content ?? '';
  assert.match(system, /file:\/\/\/config — 服务配置/, '资源清单注入系统提示词');
  assert.match(system, /greet — 生成问候/, '提示词清单注入系统提示词');
});
