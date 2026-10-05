// 已确认边界①②：真实 CLI、保存配置、HTTP/SSE 与本地会话文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, symlinkSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(10); }
  throw new Error('等待测试服务超时');
}

async function fixture(t, { sessions = [] } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tcode-projects-')));
  const data = path.join(root, 'data'), a = path.join(root, 'alpha'), b = path.join(root, 'beta');
  for (const dir of [data, a, b, path.join(data, 'sessions')]) mkdirSync(dir);
  const files = [];
  for (const [i, session] of sessions.entries()) {
    const file = path.join(data, 'sessions', `${i}.jsonl`);
    const cwd = session.project === 'beta' ? b : a;
    writeFileSync(file, [{ type: 'meta', cwd, sessionId: session.id }, ...(session.records ?? [
      { type: 'message', message: { role: 'user', content: session.user ?? `任务 ${session.id}` } },
      { type: 'message', message: { role: 'assistant', content: session.answer ?? '完成' } },
    ])].map(JSON.stringify).join('\n') + '\n');
    files.push(file);
  }
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(400).end('unexpected route'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (body.messages.at(-1)?.content === 'slow') { res.write(': waiting\n\n'); return; }
    res.end('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const configFile = path.join(data, 'config.json');
  writeFileSync(configFile, JSON.stringify({ apiKey: 'project-fixture-key', model: 'fake-model',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, workspace: a, projects: [a, b] }));
  const env = { ...process.env, TCODE_DATA_DIR: data, TCODE_APPROVAL: 'normal', TCODE_ALLOW_WRITE: '' };
  for (const key of ['TCODE_API_KEY', 'TCODE_BASE_URL', 'TCODE_MODEL', 'TCODE_PROTOCOL', 'TCODE_CONTEXT_LIMIT']) delete env[key];
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
  return { root, data, a, b, files, configFile,
    state: async () => (await fetch(url + 'state')).json(),
    post: (route, body = {}) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    restart: async () => { await stop(); await start(); },
    events: async () => fetch(url + 'events'),
  };
}

test('项目归档持久化且不删除目录或历史，恢复与打开项目均能回到导航', async (t) => {
  const h = await fixture(t, { sessions: [{ id: 'beta-history', project: 'beta' }] });
  const original = readFileSync(h.files[0], 'utf8');
  const result = await h.post('projects/archive', { workspace: h.b, archived: true });
  assert.equal(result.status, 200);
  let state = (await result.json()).state;
  assert.deepEqual(state.projects.map((p) => p.path), [h.a]);
  assert.deepEqual(state.archivedProjects, [{ path: h.b, name: 'beta', available: true, sessionCount: 1 }]);
  assert.deepEqual(JSON.parse(readFileSync(h.configFile)).archivedProjects, [h.b]);
  assert.equal(readFileSync(h.files[0], 'utf8'), original);
  await h.restart(); state = await h.state();
  assert.equal(state.archivedProjects[0].path, h.b);
  assert.equal((await h.post('config', { approval: 'never' })).status, 200);
  assert.equal((await h.state()).archivedProjects[0].path, h.b, '保存普通设置不能解除归档');
  assert.equal((await h.post('projects/archive', { workspace: h.b, archived: false })).status, 200);
  assert.equal((await h.state()).projects.some((p) => p.path === h.b), true);
  await h.post('projects/archive', { workspace: h.b, archived: true });
  assert.equal((await h.post('workspace', { workspace: h.b })).status, 200);
  state = await h.state();
  assert.equal(state.config.workspace, h.b); assert.deepEqual(state.archivedProjects, []);
  assert.equal(state.projects.some((p) => p.path === h.b), true);
  assert.equal(readFileSync(h.files[0], 'utf8'), original);
});

test('合法配置中独立保存的归档项目恢复后进入活动导航并持久化', async (t) => {
  const h = await fixture(t);
  const config = JSON.parse(readFileSync(h.configFile, 'utf8'));
  writeFileSync(h.configFile, JSON.stringify({ ...config, projects: [h.a], archivedProjects: [h.b] }));
  await h.restart();
  assert.equal((await h.state()).archivedProjects[0].path, h.b);
  const response = await h.post('projects/archive', { workspace: h.b, archived: false });
  assert.equal(response.status, 200);
  const state = (await response.json()).state;
  assert.deepEqual(state.archivedProjects, []);
  assert.equal(state.projects.some((project) => project.path === h.b), true);
  assert.equal(JSON.parse(readFileSync(h.configFile, 'utf8')).projects.includes(h.b), true);
  await h.restart();
  assert.equal((await h.state()).projects.some((project) => project.path === h.b), true);
});

test('跨项目搜索标题和原始对话正文，含归档项目并按会话与项目去重', async (t) => {
  const h = await fixture(t, { sessions: [
    { id: 'same-id', user: 'alpha Needle 内容', answer: '旧回答' },
    { id: 'same-id', project: 'beta', user: 'beta 原始输入', answer: 'NEEDLE assistant 内容' },
    { id: 'same-id', project: 'beta', user: 'beta 原始输入', answer: 'NEEDLE 最新续写' },
    { id: 'private', records: [
      { type: 'message', message: { role: 'system', content: 'secret-only' } },
      { type: 'message', message: { role: 'user', content: '普通任务' } },
      { type: 'message', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call', function: { name: 'read', arguments: 'secret-only' } }] } },
      { type: 'message', message: { role: 'tool', content: 'secret-only' } },
      { type: 'activity', event: { type: 'tool_result', output: 'secret-only' } },
    ] },
  ] });
  await h.post('projects/archive', { workspace: h.b, archived: true });
  const response = await h.post('sessions/search', { query: 'needle' });
  assert.equal(response.status, 200);
  const { sessions, truncated } = await response.json();
  assert.equal(truncated, false); assert.equal(sessions.length, 2);
  assert.deepEqual(new Set(sessions.map((s) => s.cwd)), new Set([h.a, h.b]));
  assert.equal(sessions.find((s) => s.cwd === h.a).archived, false);
  const beta = sessions.find((s) => s.cwd === h.b);
  assert.equal(beta.archived, true); assert.equal(beta.available, true);
  assert.match(beta.excerpt, /NEEDLE 最新续写/);
  assert.equal(sessions.every((s) => !('file' in s)), true);
  assert.deepEqual((await (await h.post('sessions/search', { query: 'secret-only' })).json()).sessions, []);
  assert.deepEqual((await (await h.post('sessions/search', { query: '' })).json()), { sessions: [], truncated: false });
});

test('同一会话标识跨项目重命名互不串标题，并兼容旧标题索引', async (t) => {
  const h = await fixture(t, { sessions: [{ id: 'shared' }, { id: 'shared', project: 'beta' }] });
  writeFileSync(path.join(h.data, 'sessions', 'titles.json'), JSON.stringify({ shared: '旧索引标题' }));
  assert.equal((await (await h.post('sessions/search', { query: '旧索引标题' })).json()).sessions.length, 2);
  assert.equal((await h.post('session/rename', { id: 'shared', title: 'AlphaName' })).status, 200);
  assert.equal((await h.post('workspace', { workspace: h.b })).status, 200);
  assert.equal((await h.post('session/rename', { id: 'shared', title: 'BetaName' })).status, 200);
  const alpha = (await (await h.post('sessions/search', { query: 'alphaname' })).json()).sessions;
  assert.equal(alpha.length, 1); assert.equal(alpha[0].cwd, h.a); assert.equal(alpha[0].title, 'AlphaName');
  const beta = (await (await h.post('sessions/search', { query: 'betaname' })).json()).sessions;
  assert.equal(beta.length, 1); assert.equal(beta[0].cwd, h.b); assert.equal(beta[0].title, 'BetaName');
});

test('打开跨项目搜索结果恢复指定历史与归档，目标归属校验失败保持当前会话', async (t) => {
  const h = await fixture(t, { sessions: [{ id: 'shared', user: 'alpha 原会话' }, { id: 'shared', project: 'beta', user: 'beta 指定历史' }] });
  await h.post('projects/archive', { workspace: h.b, archived: true });
  const source = readFileSync(h.files[1], 'utf8');
  const before = await h.state(), config = readFileSync(h.configFile, 'utf8');
  for (const input of [{ id: 'missing', workspace: h.b }, { id: 'shared', workspace: path.join(h.root, 'missing') }, { id: 'shared', workspace: 'relative' }]) {
    const bad = await h.post('session/select', input);
    assert.equal(bad.status, 400);
    const state = await h.state();
    assert.equal(state.currentSessionId, before.currentSessionId); assert.equal(state.config.workspace, before.config.workspace);
    assert.deepEqual(state.messages, before.messages); assert.equal(readFileSync(h.configFile, 'utf8'), config);
  }
  const response = await h.post('session/select', { id: 'shared', workspace: h.b });
  assert.equal(response.status, 200);
  const state = (await response.json()).state;
  assert.equal(state.config.workspace, h.b); assert.equal(state.currentSessionId, 'shared');
  assert.deepEqual(state.messages, [{ role: 'user', content: 'beta 指定历史' }, { role: 'assistant', content: '完成' }]);
  assert.deepEqual(state.archivedProjects, []); assert.equal(readFileSync(h.files[1], 'utf8'), source);
  assert.equal(JSON.parse(readFileSync(h.configFile)).workspace, h.b);
  await h.restart();
  assert.equal((await h.state()).config.workspace, h.b);
  assert.deepEqual((await h.state()).messages, state.messages);
});

test('跨项目恢复日志或配置落盘失败保持原目录、上下文与活动会话', async (t) => {
  for (const failure of ['session', 'config']) await t.test(failure, async (t) => {
    const h = await fixture(t, { sessions: [{ id: 'alpha', user: '原历史' }, { id: 'beta', project: 'beta', user: '目标历史' }] });
    const before = await h.state(), config = readFileSync(h.configFile, 'utf8');
    const sessionDir = path.join(h.data, 'sessions'), files = readdirSync(sessionDir).sort();
    const readonly = failure === 'session' ? sessionDir : h.data;
    chmodSync(readonly, 0o500); t.after(() => chmodSync(readonly, 0o700));
    assert.equal((await h.post('session/select', { id: 'beta', workspace: h.b })).status, 500);
    const after = await h.state();
    assert.equal(after.config.workspace, before.config.workspace); assert.equal(after.currentSessionId, before.currentSessionId);
    assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.activity, before.activity);
    assert.equal(readFileSync(h.configFile, 'utf8'), config); assert.deepEqual(readdirSync(sessionDir).sort(), files);
    chmodSync(readonly, 0o700);
    const fresh = await (await h.post('session/new')).json();
    assert.equal(fresh.state.sessions.find((s) => s.id === fresh.state.currentSessionId).cwd, h.a, '失败后实际进程目录也必须恢复');
  });
});

test('归档通过 SSE 同步，非法输入和运行中操作不能变更项目或会话', async (t) => {
  const h = await fixture(t, { sessions: [{ id: 'alpha' }, { id: 'beta', project: 'beta' }] });
  const response = await h.events(), reader = response.body.getReader();
  t.after(() => reader.cancel());
  let buffer = '';
  async function event(type) {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith('data: ')) { const value = JSON.parse(frame.slice(6)); if (value.type === type) return value; }
      } else { const { value, done } = await reader.read(); if (done) throw new Error('SSE 意外结束'); buffer += new TextDecoder().decode(value); }
    }
  }
  await event('hello');
  const before = await h.state(), config = readFileSync(h.configFile, 'utf8');
  assert.equal((await h.post('projects/archive', { workspace: h.a, archived: true })).status, 409);
  for (const input of [{ workspace: h.root, archived: true }, { workspace: 'relative', archived: true }, { workspace: h.b, archived: 'true' }]) {
    assert.equal((await h.post('projects/archive', input)).status, 400);
  }
  assert.equal(readFileSync(h.configFile, 'utf8'), config);
  assert.equal((await h.state()).currentSessionId, before.currentSessionId);
  assert.equal((await h.post('projects/archive', { workspace: h.b, archived: true })).status, 200);
  assert.equal((await event('state')).state.archivedProjects[0].path, h.b);
  assert.equal((await h.post('send', { text: 'slow' })).status, 200);
  await until(async () => (await h.state()).busy);
  const running = await h.state(), saved = readFileSync(h.configFile, 'utf8');
  assert.equal((await h.post('projects/archive', { workspace: h.b, archived: false })).status, 409);
  assert.equal((await h.post('session/select', { id: 'beta', workspace: h.b })).status, 409);
  assert.equal((await h.state()).currentSessionId, running.currentSessionId);
  assert.equal(readFileSync(h.configFile, 'utf8'), saved);
  assert.equal((await h.post('sessions/search', { query: 'beta' })).status, 200, '运行中仍可只读搜索');
  await h.post('abort'); await until(async () => !(await h.state()).busy);
});

test('搜索上限、字面量、坏行和符号链接边界，以及不可用历史项目', async (t) => {
  const h = await fixture(t, { sessions: [...Array.from({ length: 51 }, (_, i) => ({ id: `result-${i}`, user: '共同关键词' })),
    { id: 'literal', project: 'beta', user: 'literal [.*] 正文' }] });
  const directory = path.join(h.data, 'sessions');
  writeFileSync(path.join(directory, 'bad.jsonl'), 'not json\nnull\n[]\n');
  const outside = path.join(h.root, 'outside.jsonl');
  writeFileSync(outside, JSON.stringify({ type: 'meta', cwd: h.b, sessionId: 'unsafe' }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: 'symlink-secret' } }) + '\n');
  symlinkSync(outside, path.join(directory, 'link.jsonl'));
  const response = await h.post('sessions/search', { query: '共同关键词' });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.sessions.length, 50); assert.equal(result.truncated, true);
  assert.equal((await (await h.post('sessions/search', { query: '[.*]' })).json()).sessions.length, 1);
  assert.deepEqual((await (await h.post('sessions/search', { query: 'symlink-secret' })).json()).sessions, []);
  for (const query of [null, 1, 'x'.repeat(201)]) assert.equal((await h.post('sessions/search', { query })).status, 400);
  rmSync(h.b, { recursive: true });
  const unavailable = (await (await h.post('sessions/search', { query: '[.*]' })).json()).sessions[0];
  assert.equal(unavailable.available, false);
  const before = await h.state();
  assert.equal((await h.post('session/select', { id: unavailable.id, workspace: unavailable.cwd })).status, 400);
  assert.equal((await h.state()).currentSessionId, before.currentSessionId);
});

test('会话标识与 JSON 原型同名时仍按普通历史搜索，未完成流式正文可跨分片匹配', async (t) => {
  const h = await fixture(t, { sessions: [{ id: 'toString', user: '普通名字任务' }, { id: '__proto__', project: 'beta', records: [
    { type: 'activity', event: { type: 'user', text: '流式任务' } },
    { type: 'activity', event: { type: 'text', delta: '跨分' } },
    { type: 'activity', event: { type: 'text', delta: '片内容' } },
  ] }] });
  const response = await h.post('sessions/search', { query: '跨分片' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].id, '__proto__');
  assert.match(result.sessions[0].excerpt, /跨分片内容/);
});
