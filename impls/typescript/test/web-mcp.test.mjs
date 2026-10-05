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
    else if (msg.method === 'tools/list') respond(msg, { tools: [{ name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
    else if (msg.method === 'tools/call') respond(msg, { content: [{ type: 'text', text: 'echo:' + (msg.params?.arguments?.text ?? '') }] });
  }
});
process.stdin.resume();
`;

async function fixture(t, { enabled = true, transport = 'stdio' } = {}) {
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
      else if (msg.method === 'tools/list') respond({ tools: [{ name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
      else if (msg.method === 'tools/call') respond({ content: [{ type: 'text', text: 'echo:' + (msg.params?.arguments?.text ?? '') }] });
      else { res.writeHead(404).end(); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      const toolName = `mcp__${transport === 'http' ? 'httponly' : 'demo'}__echo`;
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mcp-call-1', function: { name: toolName, arguments: JSON.stringify({ text: 'hi' }) } }] } }] });
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
      ? { id: 'srv-http', name: 'httponly', url: `http://127.0.0.1:${provider.address().port}/mcp`, enabled: true }
      : { id: 'srv-demo', name: 'demo', command: process.execPath, args: [fakeServerPath], enabled: true }] } : {}),
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
  assert.deepEqual(test.body.tools, ['echo']);
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

test('HTTP Streamable 传输：连接测试列出工具、桥接调用经审批回传', async (t) => {
  const h = await fixture(t, { transport: 'http' });
  await until(async () => (await h.state()).capabilities.tools.some((tool) => tool.name === 'mcp__httponly__echo'), '启动预热后 HTTP 服务器工具桥接');
  const listed = (await h.state()).capabilities.tools;
  const probe = await h.post('mcp/test', { id: 'srv-http' });
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.body.tools, ['echo']);
  const state = await approvedTurn(h);
  assert.match(state.messages.at(-1).content, /echo:hi/, 'HTTP 工具调用结果回传模型');
  assert.equal((await h.post('mcp/servers', { name: 'bad-url', url: 'ftp://x/mcp', enabled: true })).status, 400);
});
