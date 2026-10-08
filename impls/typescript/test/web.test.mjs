// 测试已确认的公共 HTTP/SSE 边界，模型为外部假端点，文件与进程都真实。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`等待超时：${label}`);
}

async function harness(t, { cli = false, unconfigured = false, reuseDir = undefined, configContent = undefined, summaryMode = 'success' } = {}) {
  const dir = reuseDir ?? mkdtempSync(path.join(tmpdir(), 'tcode-workbench-'));
  const workspace = path.join(dir, 'project');
  const requests = [];
  const releases = new Map();
  mkdirSync(workspace, { recursive: true });
  if (configContent !== undefined) {
    mkdirSync(path.join(dir, 'data'), { recursive: true });
    writeFileSync(path.join(dir, 'data', 'config.json'), configContent);
  }
  const provider = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.messages[0]?.content === '你是会话摘要器：只输出摘要正文，用简体中文，尽量精炼。') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (summaryMode !== 'empty') res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '压缩后的任务摘要' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 23, completion_tokens: 5 }, choices: [] })}\n\n`);
      if (summaryMode !== 'slow') res.end('data: [DONE]\n\n');
      return;
    }
    const user = body.messages.findLast((m) => m.role === 'user')?.content ?? '';
    if (['held success', 'held error'].includes(user)) await new Promise((resolve) => releases.set(user, resolve));
    if (user === 'held error') { res.writeHead(400).end('deliberate queued failure'); return; }
    if (user === 'error') { res.writeHead(400).end('deliberate provider failure test-key'); return; }
    if (['slow', 'slow A', 'slow B'].includes(user)) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': wait\n\n'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const hasResult = body.messages.some((m) => m.role === 'tool');
    if (user === 'write' && !hasResult) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write-1', function: { name: 'write', arguments: JSON.stringify({ file_path: 'result.txt', content: 'approved content' }) } }] } }] });
    } else if (user === '沉淀' && !hasResult) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'memory-1', function: { name: 'memory_append', arguments: JSON.stringify({ content: '记住 pnpm' }) } }] } }] });
    } else if (user === 'slow tools' && !hasResult) {
      send({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'bash-1', function: { name: 'bash', arguments: '{"command":"sleep 30"}' } },
        { index: 1, id: 'write-later', function: { name: 'write', arguments: '{"file_path":"later.txt","content":"must not write"}' } },
      ] } }] });
    } else {
      send({ choices: [{ delta: { content: `回答：${user}` } }] });
      send({ usage: { prompt_tokens: 11, completion_tokens: 7 }, choices: [] });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  const env = {
    ...process.env, TCODE_DATA_DIR: path.join(dir, 'data'), TCODE_TEST_WORKSPACE: workspace,
    TCODE_TEST_PROVIDER: endpoint, TCODE_API_KEY: unconfigured ? '' : 'test-key',
    TCODE_BASE_URL: unconfigured ? '' : endpoint, TCODE_MODEL: unconfigured ? '' : 'fake-model',
    TCODE_PROTOCOL: '', TCODE_APPROVAL: 'normal', TCODE_ALLOW_WRITE: '',
    TCODE_KEYSTORE: 'off',
  };
  const child = spawn(process.execPath, [path.join(root, cli ? 'bin/tcode.js' : 'test/web-fixture.mjs'), ...(cli ? ['web'] : [])], { cwd: cli ? workspace : root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => stdout += chunk);
  child.stderr.on('data', (chunk) => stderr += chunk);
  const streams = [];
  t.after(async () => {
    streams.forEach((stream) => stream.destroy());
    child.kill();
    await Promise.race([new Promise((resolve) => child.once('close', resolve)), delay(200)]);
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  });
  const url = await until(() => {
    if (child.exitCode !== null) throw new Error(`Web 后端退出 (${child.exitCode})：${stderr}`);
    return stdout.match(/http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]+\//)?.[0];
  }, 'Web 服务地址');
  const events = [];
  const stream = http.get(`${url}events`, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk;
      let pos;
      while ((pos = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, pos); buffer = buffer.slice(pos + 2);
        const line = block.split('\n').find((value) => value.startsWith('data:'));
        if (line) events.push(JSON.parse(line.slice(5)));
      }
    });
  });
  stream.on('error', () => {}); streams.push(stream);
  await until(() => events.some((event) => event.type === 'hello'), 'SSE hello');
  const post = async (route, body) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const state = async () => (await fetch(url + 'state')).json();
  const event = (type, from = 0) => until(() => events.slice(from).find((value) => value.type === type), type);
  return { url, post, state, event, events, workspace, dir, child, endpoint, streams, requests, release: (text) => releases.get(text)?.() };
}

test('手动压缩的模型用量进入当前会话与统计，刷新、重启和重复恢复不双计', async (t) => {
  const h = await harness(t);
  for (const text of ['历史一', '历史二', '历史三']) {
    const mark = h.events.length;
    await h.post('send', { text }); await h.event('turn_end', mark);
  }
  assert.deepEqual((await h.state()).usage, { prompt_tokens: 33, completion_tokens: 21 });
  const mark = h.events.length;
  const compacted = await h.post('command', { line: '/compact' });
  assert.equal(compacted.status, 200);
  assert.match(compacted.body.output, /已压缩/);
  assert.deepEqual(compacted.body.state.usage, { prompt_tokens: 56, completion_tokens: 26 });
  assert.equal((await h.event('usage', mark)).prompt_tokens, 23);
  assert.ok(compacted.body.state.messages[0].content.includes('压缩后的任务摘要'));
  const expected = { sessions: 1, projects: 1, inputTokens: 56, outputTokens: 26, totalTokens: 82 };
  assert.deepEqual(await (await fetch(h.url + 'usage')).json(), expected);
  assert.deepEqual((await h.state()).usage, { prompt_tokens: 56, completion_tokens: 26 });
  const id = compacted.body.state.currentSessionId;
  const closed = new Promise((resolve) => h.child.once('close', resolve));
  h.streams.forEach((stream) => stream.destroy()); h.child.kill(); await closed;
  const restarted = await harness(t, { reuseDir: h.dir });
  for (let i = 0; i < 2; i++) await restarted.post('session/select', { id });
  assert.deepEqual((await restarted.state()).usage, { prompt_tokens: 56, completion_tokens: 26 });
  assert.deepEqual(await (await fetch(restarted.url + 'usage')).json(), expected);
});

test('自动压缩与后续回答的模型用量都进入统计并可在重启后恢复', async (t) => {
  const h = await harness(t);
  for (const text of ['历史一', '历史二', '历史三']) {
    const mark = h.events.length;
    await h.post('send', { text }); await h.event('turn_end', mark);
  }
  assert.equal((await h.post('config', { contextLimit: 1 })).status, 200);
  const mark = h.events.length;
  await h.post('send', { text: '压缩后继续' }); await h.event('turn_end', mark);
  assert.ok(h.events.slice(mark).some((event) => event.type === 'compact'));
  assert.deepEqual((await h.state()).usage, { prompt_tokens: 67, completion_tokens: 33 });
  assert.equal(h.events.slice(mark).filter((event) => event.type === 'usage').length, 2);
  const expected = { sessions: 1, projects: 1, inputTokens: 67, outputTokens: 33, totalTokens: 100 };
  assert.deepEqual(await (await fetch(h.url + 'usage')).json(), expected);
  const closed = new Promise((resolve) => h.child.once('close', resolve));
  h.streams.forEach((stream) => stream.destroy()); h.child.kill(); await closed;
  const restarted = await harness(t, { reuseDir: h.dir });
  assert.deepEqual((await restarted.state()).usage, { prompt_tokens: 67, completion_tokens: 33 });
  assert.deepEqual(await (await fetch(restarted.url + 'usage')).json(), expected);
});

test('停止手动压缩保留已返回的模型用量，原历史不变且服务可继续执行', async (t) => {
  const h = await harness(t, { summaryMode: 'slow' });
  for (const text of ['历史一', '历史二', '历史三']) {
    const mark = h.events.length;
    await h.post('send', { text }); await h.event('turn_end', mark);
  }
  const before = (await h.state()).messages;
  const mark = h.events.length;
  const command = h.post('command', { line: '/compact' });
  await h.event('usage', mark);
  assert.equal((await h.state()).busy, true);
  await h.post('abort', {});
  const stopped = await Promise.race([command, delay(1000).then(() => { throw new Error('停止没有结束压缩命令'); })]);
  assert.equal(stopped.status, 200);
  assert.match(stopped.body.output, /压缩未执行.*aborted/);
  assert.equal(stopped.body.state.busy, false);
  assert.deepEqual(stopped.body.state.messages, before);
  assert.deepEqual(stopped.body.state.usage, { prompt_tokens: 56, completion_tokens: 26 });
  assert.deepEqual(await (await fetch(h.url + 'usage')).json(), { sessions: 1, projects: 1, inputTokens: 56, outputTokens: 26, totalTokens: 82 });
  const continuedMark = h.events.length;
  await h.post('send', { text: '停止后继续' }); await h.event('turn_end', continuedMark);
  assert.equal((await h.state()).messages.findLast((message) => message.role === 'assistant').content, '回答：停止后继续');
});

test('停止自动压缩不裁剪历史或追加新输入，已返回的用量在重启后保留', async (t) => {
  const h = await harness(t, { summaryMode: 'slow' });
  for (const text of ['历史一', '历史二', '历史三']) {
    const mark = h.events.length;
    await h.post('send', { text }); await h.event('turn_end', mark);
  }
  const before = (await h.state()).messages;
  await h.post('config', { contextLimit: 1 });
  const mark = h.events.length;
  await h.post('send', { text: '本轮已停止，不能追加' }); await h.event('usage', mark);
  await h.post('abort', {});
  assert.equal((await h.event('turn_end', mark)).reason, 'aborted');
  const stopped = await h.state();
  assert.deepEqual(stopped.messages, before);
  assert.equal(h.events.slice(mark).some((event) => event.type === 'user'), false);
  assert.deepEqual(stopped.usage, { prompt_tokens: 56, completion_tokens: 26 });
  const closed = new Promise((resolve) => h.child.once('close', resolve));
  h.streams.forEach((stream) => stream.destroy()); h.child.kill(); await closed;
  const restarted = await harness(t, { reuseDir: h.dir });
  assert.deepEqual((await restarted.state()).messages, before);
  assert.deepEqual(await (await fetch(restarted.url + 'usage')).json(), { sessions: 1, projects: 1, inputTokens: 56, outputTokens: 26, totalTokens: 82 });
});

test('空摘要不改变历史，但模型已返回的用量仍记录到会话统计', async (t) => {
  const h = await harness(t, { summaryMode: 'empty' });
  for (const text of ['历史一', '历史二', '历史三']) {
    const mark = h.events.length;
    await h.post('send', { text }); await h.event('turn_end', mark);
  }
  const before = (await h.state()).messages;
  const failed = await h.post('command', { line: '/compact' });
  assert.equal(failed.status, 200);
  assert.match(failed.body.output, /压缩未执行.*空摘要/);
  assert.deepEqual(failed.body.state.messages, before);
  assert.deepEqual(failed.body.state.usage, { prompt_tokens: 56, completion_tokens: 26 });
  assert.deepEqual(await (await fetch(h.url + 'usage')).json(), { sessions: 1, projects: 1, inputTokens: 56, outputTokens: 26, totalTokens: 82 });
});

test('选择项目不依赖模型配置，最近项目持久化且无效目录不改变工作区', async (t) => {
  const h = await harness(t, { cli: true, unconfigured: true });
  const chosen = (await h.post('workspace', { workspace: h.workspace }));
  assert.equal(chosen.status, 200);
  assert.equal(chosen.body.state.ready, false);
  assert.equal(chosen.body.state.config.workspace, realpathSync(h.workspace));
  assert.ok(chosen.body.state.projects.some((project) => project.path === realpathSync(h.workspace)));
  assert.equal((await h.post('workspace', { workspace: path.join(h.dir, 'missing') })).status, 400);
  assert.equal((await h.state()).config.workspace, realpathSync(h.workspace));
  h.child.kill(); await delay(100);
  const restarted = await harness(t, { cli: true, unconfigured: true, reuseDir: h.dir });
  assert.equal((await restarted.state()).config.workspace, realpathSync(h.workspace));
  assert.equal((await restarted.state()).projects[0].path, realpathSync(h.workspace));
});

test('旧配置的当前项目在首次切换后仍留在最近项目，并在重启后保留', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-legacy-projects-'));
  const original = path.join(dir, 'project'), selected = path.join(dir, 'selected'), third = path.join(dir, 'third');
  for (const directory of [original, selected, third]) mkdirSync(directory);
  const h = await harness(t, { cli: true, reuseDir: dir, configContent: JSON.stringify({ workspace: original }) });
  const switched = await h.post('workspace', { workspace: selected });
  assert.equal(switched.status, 200);
  assert.deepEqual(switched.body.state.projects.map((project) => project.path), [realpathSync(selected), realpathSync(original)]);
  const configured = await h.post('config', { workspace: third });
  assert.equal(configured.status, 200);
  assert.deepEqual(configured.body.state.projects.map((project) => project.path), [realpathSync(third), realpathSync(selected), realpathSync(original)]);
  h.streams.forEach((stream) => stream.destroy()); h.child.kill();
  await new Promise((resolve) => h.child.once('close', resolve));
  const restarted = await harness(t, { cli: true, reuseDir: dir });
  assert.deepEqual((await restarted.state()).projects.map((project) => project.path), [realpathSync(third), realpathSync(selected), realpathSync(original)]);
});

test('常规和外观设置可持久化，权限默认真实生效且临时放行不带到新任务', async (t) => {
  const h = await harness(t, { cli: true });
  const settings = { theme: 'light', fontSize: 18, enterToSend: false };
  assert.equal((await h.post('preferences', settings)).status, 200);
  assert.deepEqual((await h.state()).preferences, settings);
  assert.equal((await h.post('preferences', { fontSize: 1 })).status, 400);
  assert.equal((await h.post('config', { approval: 'never', allowWriteDirs: [h.workspace] })).status, 200);
  assert.equal((await h.state()).yolo, true);
  assert.equal((await h.post('config', { approval: 'normal' })).status, 200);
  assert.equal((await h.state()).yolo, false);
  await h.post('yolo', { value: true });
  await h.post('session/new', {});
  assert.equal((await h.state()).yolo, false, '临时免审批只作用于当前任务');
  await h.post('command', { line: '/plan' });
  await h.post('session/new', {});
  assert.equal((await h.state()).planMode, false);
  h.child.kill(); await delay(100);
  const restarted = await harness(t, { cli: true, reuseDir: h.dir });
  assert.deepEqual((await restarted.state()).preferences, settings);
  assert.deepEqual((await restarted.state()).config.allowWriteDirs, [realpathSync(h.workspace)]);
  assert.equal(JSON.stringify(await restarted.state()).includes('test-key'), false);
});

test('技能可创建和读取并进入真实模型上下文，命令列表来自已注册能力', async (t) => {
  const h = await harness(t, { cli: true });
  await h.post('workspace', { workspace: h.workspace });
  assert.ok((await h.state()).capabilities.commands.some((command) => command.name === 'plan'));
  assert.equal((await h.post('skills', { scope: 'global', name: 'global-check.md', content: '# 独立全局技能\n仅验证隔离目录。' })).status, 200);
  assert.equal((await h.post('skills', { scope: 'project', name: 'project-check.md', content: '# 项目检查\n按当前项目规范验证。' })).status, 200);
  const state = await h.state();
  assert.ok(state.capabilities.skills.some((skill) => skill.name === 'global-check.md' && skill.path.startsWith(path.join(h.dir, 'data'))));
  const read = await (await fetch(h.url + 'skills?scope=project&name=project-check.md')).json();
  assert.equal(read.content, '# 项目检查\n按当前项目规范验证。');
  assert.equal((await h.post('skills', { scope: 'project', name: '../escape.md', content: '禁止越界' })).status, 400);
  const alias = path.join(h.workspace, '.tcode', 'skills', 'alias.md');
  writeFileSync(path.join(h.dir, 'outside.md'), 'outside original');
  symlinkSync(path.join(h.dir, 'outside.md'), alias);
  assert.equal((await h.post('skills', { scope: 'project', name: 'alias.md', content: '不得写到外面' })).status, 400);
  assert.equal(readFileSync(path.join(h.dir, 'outside.md'), 'utf8'), 'outside original');
  await h.post('send', { text: '检查当前技能索引' });
  await h.event('turn_end');
  assert.ok(h.requests[0].messages[0].content.includes('global-check.md'));
  assert.ok(h.requests[0].messages[0].content.includes('project-check.md'));
  assert.ok(h.requests[0].messages[0].content.includes(realpathSync(h.workspace)));
});

test('项目切换恢复各自会话，用量按稳定会话去重且运行期间拒绝设置更改', async (t) => {
  const h = await harness(t, { cli: true });
  const other = path.join(h.dir, 'other'); mkdirSync(other);
  await h.post('workspace', { workspace: h.workspace });
  await h.post('send', { text: '项目 A 任务' }); await h.event('turn_end');
  const firstId = (await h.state()).currentSessionId;
  await h.post('workspace', { workspace: other });
  const mark = h.events.length;
  await h.post('send', { text: '项目 B 任务' }); await h.event('turn_end', mark);
  await h.post('workspace', { workspace: h.workspace });
  assert.equal((await h.state()).currentSessionId, firstId);
  const usage = await (await fetch(h.url + 'usage')).json();
  assert.deepEqual(usage, { sessions: 2, projects: 2, inputTokens: 22, outputTokens: 14, totalTokens: 36 });
  await h.post('send', { text: 'slow' }); await h.event('turn_start', h.events.length - 1);
  assert.equal((await h.post('workspace', { workspace: other })).status, 409);
  assert.equal((await h.post('preferences', { theme: 'dark' })).status, 409);
  assert.equal((await h.post('config', { approval: 'never' })).status, 409);
  assert.equal((await h.post('skills', { scope: 'project', name: 'busy.md', content: 'busy' })).status, 409);
  await h.post('abort', {});
});

test('符号链接技能目录不进入设置列表或模型索引', async (t) => {
  const h = await harness(t, { cli: true });
  const outside = path.join(h.dir, 'outside-skills');
  mkdirSync(path.join(outside, 'skills'), { recursive: true });
  writeFileSync(path.join(outside, 'skills', 'outside.md'), '# 不属于本项目的技能');
  symlinkSync(outside, path.join(h.workspace, '.tcode'));
  await h.post('workspace', { workspace: h.workspace });
  assert.equal((await h.state()).capabilities.skills.some((skill) => skill.name === 'outside.md'), false);
  await h.post('send', { text: '索引边界检查' }); await h.event('turn_end');
  assert.equal(h.requests[0].messages[0].content.includes('outside.md'), false);
});

test('保存设置不会跟随预存临时文件符号链接覆盖外部文件', async (t) => {
  const h = await harness(t);
  const outside = path.join(h.dir, 'outside.txt'); writeFileSync(outside, 'original outside');
  symlinkSync(outside, path.join(h.dir, 'data', 'config.json.tmp'));
  assert.equal((await h.post('preferences', { theme: 'dark' })).status, 200);
  assert.equal(readFileSync(outside, 'utf8'), 'original outside');
  assert.equal((await h.state()).preferences.theme, 'dark');
});

test('模型错误结束本轮后，Web 服务仍能接受下一次请求', async (t) => {
  const h = await harness(t);
  await h.post('send', { text: 'error' });
  await h.event('turn_end');
  assert.equal(JSON.stringify(h.events).includes('test-key'), false, '模型错误正文回显凭证时，SSE须在展示和落盘前隐藏');
  assert.equal(JSON.stringify(await h.state()).includes('test-key'), false);
  await delay(100);
  assert.equal(h.child.exitCode, null, '模型错误不能让整个 Web 后端退出');
  const response = await fetch(h.url);
  assert.equal(response.status, 200, '模型错误不能让整个 Web 后端退出');
  const mark = h.events.length;
  assert.equal((await h.post('send', { text: 'recovered' })).status, 200);
  await h.event('turn_end', mark);
});

test('等待写入审批时停止立即结束，迟到的允许无效且文件未写入', async (t) => {
  const h = await harness(t);
  await h.post('send', { text: 'write' });
  const pending = await h.event('permission');
  await h.post('abort', {});
  const end = await h.event('turn_end');
  assert.equal(end.reason ?? (h.events.some((event) => event.type === 'aborted') ? 'aborted' : undefined), 'aborted');
  assert.equal((await h.post('permission', { id: pending.id, decision: 'allow' })).status, 404);
  assert.equal(existsSync(path.join(h.workspace, 'result.txt')), false);
});

test('首次没有模型配置也能打开设置，保存有效配置后可以执行任务', async (t) => {
  const h = await harness(t, { cli: true, unconfigured: true });
  assert.equal((await h.state()).ready, false);
  const saved = await h.post('config', { apiKey: 'test-key', baseUrl: h.endpoint, model: 'fake-model', workspace: h.workspace, protocol: 'openai', contextLimit: 32000 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.state.ready, true);
  assert.equal(JSON.stringify(saved.body).includes('test-key'), false, '配置响应不能回传凭证');
  await h.post('send', { text: 'first run' });
  await h.event('turn_end');
});

test('会话按稳定标识切换，恢复完整历史与用量，标题不会依赖列表编号', async (t) => {
  const h = await harness(t);
  await h.post('send', { text: 'saved conversation' });
  await h.event('turn_end');
  const first = await h.state();
  assert.equal(typeof first.currentSessionId, 'string');
  assert.equal((await h.post('session/rename', { id: first.currentSessionId, title: '我的项目任务' })).status, 200);
  assert.equal((await h.post('session/new', {})).status, 200);
  assert.notEqual((await h.state()).currentSessionId, first.currentSessionId);
  assert.equal((await h.post('session/select', { id: first.currentSessionId })).status, 200);
  const restored = await h.state();
  assert.equal(restored.currentSessionId, first.currentSessionId);
  assert.equal(restored.title, '我的项目任务');
  assert.ok(restored.activity.some((event) => event.type === 'text' && event.delta === '回答：saved conversation'));
  assert.deepEqual(restored.usage, { prompt_tokens: 11, completion_tokens: 7 });
  assert.equal(restored.sessions.filter((session) => session.id === first.currentSessionId).length, 1);
});

test('重启后恢复最近项目会话，原消息文件不被继续写入', async (t) => {
  const h = await harness(t);
  await h.post('send', { text: 'restart history' });
  await h.event('turn_end');
  const before = await h.state();
  const originalFile = path.join(h.dir, 'data', 'sessions', before.currentSessionId);
  const bytes = readFileSync(originalFile);
  h.streams.forEach((stream) => stream.destroy());
  const closed = new Promise((resolve) => h.child.once('close', resolve));
  h.child.kill(); await closed;
  const restarted = await harness(t, { reuseDir: h.dir });
  const state = await restarted.state();
  assert.equal(state.currentSessionId, before.currentSessionId);
  assert.ok(state.activity.some((event) => event.type === 'text' && event.delta === '回答：restart history'));
  const mark = restarted.events.length;
  await restarted.post('send', { text: 'after restart' });
  await restarted.event('turn_end', mark);
  assert.deepEqual(readFileSync(originalFile), bytes);
});

test('并发慢请求只启动一轮，停止仍能结束实际正在跑的任务', async (t) => {
  const h = await harness(t);
  const requests = ['slow A', 'slow B'].map((text) => {
    const body = JSON.stringify({ text });
    let req;
    const response = new Promise((resolve, reject) => {
      req = http.request(h.url + 'send', { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.write(body.slice(0, 5));
    });
    return { req, body, response };
  });
  await delay(80);
  requests.forEach(({ req, body }) => req.end(body.slice(5)));
  assert.deepEqual((await Promise.all(requests.map((r) => r.response))).sort(), [200, 409]);
  await h.post('abort', {});
  assert.equal((await h.event('turn_end')).reason, 'aborted');
  assert.equal(h.events.filter((event) => event.type === 'turn_start').length, 1);
});

test('配置内容损坏时仍能进入设置修复，错误和响应不回显凭证', async (t) => {
  for (const content of ['null', '{"apiKey":"hidden-secret","baseUrl":42}', '{"protocol":"hidden-secret"}']) {
    await t.test(content.startsWith('null') ? '非对象' : content.includes('baseUrl') ? '字段类型' : '协议枚举', async (s) => {
      const h = await harness(s, { cli: true, unconfigured: true, configContent: content });
      const state = await h.state();
      assert.equal(state.ready, false);
      assert.ok(state.configError);
      assert.equal(JSON.stringify(state).includes('hidden-secret'), false);
      assert.equal((await h.post('config', { apiKey: 'test-key', baseUrl: h.endpoint, model: 'fake-model', workspace: h.workspace })).status, 200);
      assert.equal((await h.state()).ready, true);
    });
  }
});

test('刷新可恢复等待审批，强制重启保留本轮上下文并使旧审批失效', async (t) => {
  const h = await harness(t);
  await h.post('send', { text: 'write' });
  const permission = await h.event('permission');
  const refreshed = await h.state();
  assert.equal(refreshed.busy, true);
  assert.equal(refreshed.status, 'waiting_approval');
  assert.equal(refreshed.pending[0].id, permission.id);
  assert.equal((await h.post('session/new', {})).status, 409);
  const closed = new Promise((resolve) => h.child.once('close', resolve));
  h.streams.forEach((stream) => stream.destroy());
  h.child.kill(); await closed;
  const restarted = await harness(t, { reuseDir: h.dir });
  const state = await restarted.state();
  assert.equal(state.currentSessionId, refreshed.currentSessionId);
  assert.equal(state.busy, false);
  assert.equal(state.status, 'aborted');
  assert.deepEqual(state.pending, []);
  assert.ok(state.messages.some((message) => message.role === 'user' && message.content === 'write'));
  assert.ok(state.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'write-1'));
  assert.equal((await restarted.post('permission', { id: permission.id, decision: 'allow' })).status, 404);
  assert.equal(existsSync(path.join(h.workspace, 'result.txt')), false);
});

test('从目录别名启动真实 CLI，当前项目会话仍可见且可恢复', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-alias-'));
  const workspace = path.join(dir, 'project'); mkdirSync(workspace);
  const alias = path.join(dir, 'alias'); symlinkSync(workspace, alias, 'junction');
  const h = await harness(t, { cli: true, reuseDir: dir, configContent: JSON.stringify({ workspace: alias }) });
  await h.post('send', { text: 'alias history' }); await h.event('turn_end');
  const state = await h.state();
  assert.equal(state.config.workspace, realpathSync(workspace));
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].id, state.currentSessionId);
});

test('允许审批后实际文件与完整工具结果一致，重复审批无效', async (t) => {
  const h = await harness(t);
  await h.post('send', { text: 'write' });
  const pending = await h.event('permission');
  assert.equal((await h.post('permission', { id: pending.id, decision: 'allow' })).status, 200);
  assert.equal((await h.post('permission', { id: pending.id, decision: 'allow' })).status, 404);
  assert.equal((await h.event('turn_end')).reason, 'completed');
  assert.equal(readFileSync(path.join(h.workspace, 'result.txt'), 'utf8'), 'approved content');
  const result = await h.event('tool_result');
  assert.equal(result.call_id, 'write-1');
  assert.equal(typeof result.output, 'string');
  assert.ok((await h.state()).activity.some((event) => event.type === 'tool_result' && event.output === result.output));
});

test('非法配置返回可修复的400且保留原配置，旧resume命令不跨项目读取', async (t) => {
  const h = await harness(t);
  const before = await h.state();
  const bad = await h.post('config', { baseUrl: 'file:///secret', model: 'fake-model', workspace: h.workspace });
  assert.equal(bad.status, 400);
  assert.deepEqual((await h.state()).config, before.config);
  const result = await h.post('command', { line: '/resume 1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.state.currentSessionId, before.currentSessionId);
  assert.match(result.body.output, /当前项目/);
  assert.equal((await h.post('send', null)).status, 400);
});

test('停止正在执行的命令后，同批后续写入工具不会执行', async (t) => {
  const h = await harness(t);
  await h.post('yolo', { value: true });
  await h.post('send', { text: 'slow tools' });
  assert.equal((await h.event('tool_call')).name, 'bash');
  await delay(80); await h.post('abort', {});
  assert.equal((await h.event('turn_end')).reason, 'aborted');
  assert.equal(existsSync(path.join(h.workspace, 'later.txt')), false);
  const state = await h.state();
  const answered = new Set(state.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
  for (const message of state.messages) {
    for (const call of message.tool_calls ?? []) assert.ok(answered.has(call.id), `工具调用 ${call.id} 必须补齐终止结果`);
  }
});

test('命令输出进入会话历史，刷新状态不会擦掉帮助结果', async (t) => {
  const h = await harness(t);
  const result = await h.post('command', { line: '/help' });
  assert.equal(result.status, 200);
  assert.ok(result.body.output.includes('/help'));
  assert.ok((await h.state()).activity.some((event) => event.type === 'command' && event.output === result.body.output));
});

test('长期记忆端点：读取、保存、清空 memory.md 且保存后注入系统提示词', async (t) => {
  const h = await harness(t);
  const memoryFile = path.join(h.dir, 'data', 'memory.md');
  writeFileSync(memoryFile, '- 旧记忆一条\n');

  const read1 = await fetch(h.url + 'memory');
  assert.equal(read1.status, 200);
  assert.deepEqual(await read1.json(), { content: '- 旧记忆一条\n' });

  const saved = await h.post('memory', { content: '- 新记忆：用户偏好 pnpm\n- 回答要简短\n' });
  assert.equal(saved.status, 200);
  assert.equal(readFileSync(memoryFile, 'utf8'), '- 新记忆：用户偏好 pnpm\n- 回答要简短\n', '保存必须真实写文件');
  const mode = execFileSync('node', ['-e', `console.log((require('fs').statSync(${JSON.stringify(memoryFile)}).mode & 0o777).toString(8))`]).toString().trim();
  assert.equal(mode, '600', '记忆文件权限 0600');

  const oversized = 'x'.repeat(256 * 1024 + 1);
  assert.equal((await h.post('memory', { content: oversized })).status, 400);

  const state = await h.state();
  void state;
  await h.post('send', { text: '随便说点什么' });
  await until(() => h.requests.length > 0 && h.requests[0].messages[0]?.content?.includes('新记忆：用户偏好 pnpm'), '保存后注入系统提示词');

  const removed = await h.post('memory/clear', {});
  assert.equal(removed.status, 200);
  assert.equal(existsSync(memoryFile), false, '清空删除记忆文件');
  assert.deepEqual(await (await fetch(h.url + 'memory')).json(), { content: '' });
});

test('记忆端点校验：content 须为字符串', async (t) => {
  const h = await harness(t);
  assert.equal((await h.post('memory', { content: 123 })).status, 400);
  assert.equal((await h.post('memory', {})).status, 400);
});

test('afterTurn 钩子：轮末以项目目录执行、输出回显会话、状态经环境变量传递', async (t) => {
  const hookFile = () => path.join(tmpdir(), `tcode-hook-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const marker = hookFile();
  t.after(() => { try { unlinkSync(marker); } catch {} });
  const hookCommand = process.platform === 'win32'
    ? `echo %TCODE_HOOK_STATUS% > "${marker}"`
    : `echo "$TCODE_HOOK_STATUS" > '${marker}'`;
  const h = await harness(t, { cli: true, configContent: JSON.stringify({ afterTurn: hookCommand }) });
  await h.post('send', { text: 'write' });
  const pending = await h.event('permission');
  await h.post('permission', { id: pending.id, decision: 'allow' });
  await h.event('turn_end');
  await until(() => existsSync(marker), '钩子写标记文件');
  assert.equal(readFileSync(marker, 'utf8').trim(), 'completed', '钩子环境变量携带轮次状态');
});

test('afterTurn 钩子的 stdout 回显到会话', async (t) => {
  const h = await harness(t, { cli: true, configContent: JSON.stringify({ afterTurn: 'echo hook-ran' }) });
  await h.post('send', { text: '正常回答' });
  const echoed = await until(() => h.events.findLast((event) => event.type === 'command' && event.output?.includes('轮结束钩子输出：')), '钩子输出回显');
  assert.match(echoed.output, /hook-ran/);
});

test('afterTurn 等待完成后才释放会话锁，延迟输出归属原会话', async (t) => {
  const hook = `"${process.execPath}" -e "const fs=require('node:fs');fs.writeFileSync('hook-started','1');const timer=setInterval(()=>{if(fs.existsSync('hook-release')){clearInterval(timer);console.log('original-hook');}},10)"`;
  const h = await harness(t, { cli: true, configContent: JSON.stringify({ afterTurn: hook }) });
  t.after(() => writeFileSync(path.join(h.workspace, 'hook-release'), '1'));
  const original = (await h.state()).currentSessionId;
  await h.post('send', { text: '正常回答' });
  const ended = await h.event('turn_end');
  await until(() => existsSync(path.join(h.workspace, 'hook-started')), 'Hook 开始');
  assert.equal((await h.state()).busy, true, '模型结束后仍需等待 Hook');
  assert.equal(ended.busy, true, 'SSE 不能提前释放客户端锁');
  assert.equal((await h.post('session/new', {})).status, 409);
  writeFileSync(path.join(h.workspace, 'hook-release'), '1');
  const output = await until(() => h.events.find((event) => event.type === 'command' && event.output?.includes('original-hook')), 'Hook 输出');
  assert.equal(output.sessionId, original);
  await until(async () => !(await h.state()).busy, 'Hook 完成');
  assert.equal((await h.post('session/new', {})).status, 200);
  assert.equal((await h.state()).activity.some((event) => event.output?.includes('original-hook')), false);
});

test('单条排队在完整轮次与 afterTurn 结束后串行执行，刷新可恢复且重试不重复执行', async (t) => {
  const hook = `"${process.execPath}" -e "const fs=require('node:fs');fs.writeFileSync('hook-started','1');const timer=setInterval(()=>{if(fs.existsSync('hook-release')){clearInterval(timer);console.log('hook-finished');}},10)"`;
  const h = await harness(t, { cli: true, configContent: JSON.stringify({ afterTurn: hook }) });
  t.after(() => writeFileSync(path.join(h.workspace, 'hook-release'), '1'));
  const original = (await h.state()).currentSessionId;
  await h.post('send', { text: '首轮' });
  await until(() => existsSync(path.join(h.workspace, 'hook-started')), '首轮 Hook 开始');
  const owner = (await h.state()).queueOwner;
  const queued = await h.post('queue', { ...owner, id: 'q-followup', text: '  后续任务  ' });
  assert.equal(queued.status, 200);
  assert.deepEqual(queued.body.state.queued, { id: 'q-followup', text: '后续任务', sessionId: original });
  assert.deepEqual((await h.state()).queueOwner, owner);
  assert.deepEqual((await h.state()).queued, queued.body.state.queued, '刷新恢复待执行输入');
  await until(() => h.events.some((event) => event.type === 'state' && event.state.queued?.id === 'q-followup'), 'SSE 广播排队状态');
  assert.equal((await h.post('queue', { ...owner, id: 'q-followup', text: '后续任务' })).status, 200, '提交重试幂等');
  assert.equal((await h.post('queue', { ...owner, id: 'q-other', text: '另一条' })).status, 409, '单槽不覆盖已接受输入');
  assert.equal((await h.post('session/new', {})).status, 409);
  assert.equal(h.requests.length, 1, 'Hook 完成前不启动排队轮次');
  const mark = h.events.length;
  writeFileSync(path.join(h.workspace, 'hook-release'), '1');
  await until(async () => !(await h.state()).busy, '两轮与 Hook 全部结束');
  const state = await h.state();
  assert.equal(state.queued, null);
  assert.equal(state.queueOwner, null);
  assert.equal(state.currentSessionId, original);
  assert.deepEqual(h.requests.map((request) => request.messages.findLast((message) => message.role === 'user').content), ['首轮', '后续任务']);
  assert.equal(h.events.slice(mark).findIndex((event) => event.type === 'command' && event.output?.includes('hook-finished')) < h.events.slice(mark).findIndex((event) => event.type === 'user' && event.text === '后续任务'), true);
  const firstFollowup = h.events.findIndex((event) => event.type === 'user' && event.text === '后续任务');
  assert.equal(h.events.slice(mark, firstFollowup).some((event) => event.type === 'state' && !event.state.busy), false, '两轮之间不释放执行锁');
  assert.equal((await h.post('queue', { ...owner, id: 'q-followup', text: '后续任务' })).status, 200, '已消费输入的迟到重试不重新执行');
  await delay(30); assert.equal(h.requests.length, 2);
});

test('排队只接受用户轮次，取消保留输入可复制且不执行，停止会一并清除排队', async (t) => {
  const h = await harness(t);
  assert.equal((await h.post('queue', { sessionId: 'none', turnId: 'none', id: 'q-idle', text: '不能执行' })).status, 409);
  await h.post('send', { text: 'write' });
  await h.event('permission');
  const owner = (await h.state()).queueOwner;
  assert.equal((await h.post('queue', { ...owner, id: 'q-empty', text: '  ' })).status, 400);
  assert.equal((await h.post('queue', { ...owner, id: '../invalid', text: '不能执行' })).status, 400);
  assert.equal((await h.post('queue', { ...owner, id: 'q-cancel', text: '待执行原文' })).status, 200);
  assert.equal((await h.post('queue', { ...owner, id: 'q-cancel', text: '另一条原文' })).status, 409);
  assert.equal((await h.post('queue/cancel', { id: 'q-wrong' })).status, 404);
  assert.equal((await h.state()).queued.id, 'q-cancel', '错误 id 不得取消别人的输入');
  assert.equal((await h.post('queue/cancel', { id: 'q-cancel' })).status, 200);
  assert.equal((await h.post('queue/cancel', { id: 'q-cancel' })).status, 200, '取消网络重试幂等');
  assert.equal((await h.state()).queued, null);
  assert.ok(h.events.some((event) => event.type === 'command' && /用户取消排队\n待执行原文/.test(event.output)));
  const permission = (await h.state()).pending[0];
  await h.post('permission', { id: permission.id, decision: 'allow' });
  await until(async () => !(await h.state()).busy, '写入轮次完成');
  assert.equal(readFileSync(path.join(h.workspace, 'result.txt'), 'utf8'), 'approved content');
  assert.equal(h.requests.some((request) => request.messages.findLast((message) => message.role === 'user')?.content === '待执行原文'), false);
  assert.equal((await h.post('queue', { ...owner, id: 'q-cancel', text: '待执行原文' })).status, 200, '迟到重试不恢复被取消输入');
  const mark = h.events.length;
  await h.post('send', { text: 'slow' }); await h.event('turn_start', mark);
  assert.equal((await h.post('queue', { ...(await h.state()).queueOwner, id: 'q-stop', text: '停止后禁止执行' })).status, 200);
  await h.post('abort', {});
  await until(async () => !(await h.state()).busy, '停止释放执行链');
  assert.equal((await h.state()).queued, null);
  assert.ok(h.events.some((event) => event.type === 'command' && /用户停止当前轮次\n停止后禁止执行/.test(event.output)));
  assert.equal(h.requests.some((request) => request.messages.findLast((message) => message.role === 'user')?.content === '停止后禁止执行'), false);
});

test('模型与前后 Hook 出错时清空待执行输入并保留可复制原因，不能自动继续', async (t) => {
  await t.test('模型错误', async (t) => {
    const h = await harness(t);
    await h.post('send', { text: 'held error' });
    await until(() => h.requests.length === 1, '模型已开始');
    assert.equal((await h.post('queue', { ...(await h.state()).queueOwner, id: 'q-error', text: '模型错误后不执行' })).status, 200);
    h.release('held error');
    await until(async () => !(await h.state()).busy, '错误释放锁');
    assert.equal((await h.state()).status, 'error');
    assert.equal((await h.state()).queued, null);
    assert.equal(h.requests.length, 1);
    assert.ok(h.events.some((event) => event.type === 'command' && /当前轮次出错.*\n模型错误后不执行/.test(event.output)));
  });
  for (const hookName of ['beforeTurn', 'afterTurn']) {
    await t.test(hookName, async (t) => {
      const hook = `"${process.execPath}" -e "const fs=require('node:fs');fs.writeFileSync('hook-started','1');const timer=setInterval(()=>{if(fs.existsSync('hook-release')){clearInterval(timer);process.exit(3);}},10)"`;
      const h = await harness(t, { cli: true, configContent: JSON.stringify({ [hookName]: hook }) });
      t.after(() => writeFileSync(path.join(h.workspace, 'hook-release'), '1'));
      await h.post('send', { text: '正常回答' });
      await until(() => existsSync(path.join(h.workspace, 'hook-started')), 'Hook 等待');
      assert.equal((await h.post('queue', { ...(await h.state()).queueOwner, id: 'q-hook', text: 'Hook 错误后不执行' })).status, 200);
      writeFileSync(path.join(h.workspace, 'hook-release'), '1');
      await until(async () => !(await h.state()).busy, 'Hook 错误释放锁');
      assert.equal((await h.state()).status, 'completed', 'Hook 错误沿用当前模型轮次继续契约');
      assert.equal((await h.state()).queued, null);
      assert.equal(h.requests.length, 1, '只执行当前轮次');
      assert.ok(h.events.some((event) => event.type === 'command' && /钩子失败.*\nHook 错误后不执行/.test(event.output)));
    });
  }
});

test('排队归属锁定完整用户轮次，旧页面和旧回执不能误排入下一轮', async (t) => {
  const h = await harness(t);
  await h.post('send', { text: 'held success' });
  await until(() => h.requests.length === 1, '首轮模型等待');
  const owner = (await h.state()).queueOwner;
  assert.equal((await h.post('queue', { ...owner, id: 'q-next', text: 'slow B' })).status, 200);
  h.release('held success');
  await until(() => h.requests.length === 2, '排队轮次模型开始');
  const nextOwner = (await h.state()).queueOwner;
  assert.notEqual(nextOwner.turnId, owner.turnId);
  assert.equal(nextOwner.sessionId, owner.sessionId);
  assert.equal((await h.post('queue', { ...owner, id: 'q-stale', text: '过时输入' })).status, 409);
  assert.equal((await h.post('queue', { ...nextOwner, id: 'q-next', text: 'slow B' })).status, 409, '旧 id 不得借新 owner 重排');
  assert.equal((await h.post('queue', { ...owner, sessionId: 'other-session', id: 'q-next', text: 'slow B' })).status, 409, '回执校验原会话');
  assert.equal((await h.post('queue', { ...owner, id: 'q-next', text: 'slow B' })).status, 200, '原提交迟到重试只确认已接受');
  assert.equal((await h.post('queue/cancel', { id: 'q-next' })).status, 404, '已执行输入不能假装取消成功');
  assert.equal((await h.post('queue', { ...nextOwner, id: 'q-current', text: '当前轮次后续' })).status, 200);
  await h.post('abort', {});
  await until(async () => !(await h.state()).busy, '停止当前串行链');
  assert.equal(h.requests.length, 2);
});

test('同轮取消多个排队输入后，迟到重试旧 id 不能复活并自动执行', async (t) => {
  const h = await harness(t);
  await h.post('send', { text: 'held success' });
  await until(() => h.requests.length === 1, '当前模型等待');
  const owner = (await h.state()).queueOwner;
  for (const id of ['q-cancelled-A', 'q-cancelled-B']) {
    assert.equal((await h.post('queue', { ...owner, id, text: `取消输入 ${id}` })).status, 200);
    assert.equal((await h.post('queue/cancel', { id })).status, 200);
  }
  const late = await h.post('queue', { ...owner, id: 'q-cancelled-A', text: '取消输入 q-cancelled-A' });
  assert.equal(late.status, 409, '旧回执被替换后仍不能重新接受已取消 id');
  assert.equal((await h.state()).queued, null);
  h.release('held success');
  await until(async () => !(await h.state()).busy, '当前轮次结束');
  assert.equal(h.requests.length, 1, '迟到请求不能成为新轮次');
  assert.equal((await h.state()).messages.filter((message) => message.role === 'user').length, 1);
});

test('命令运行时不开放用户队列，进程重启不会恢复或执行内存队列', async (t) => {
  const h = await harness(t, { summaryMode: 'slow' });
  for (const text of ['历史一', '历史二', '历史三']) {
    const mark = h.events.length;
    await h.post('send', { text }); await h.event('turn_end', mark);
    await until(async () => !(await h.state()).busy, '历史轮次结束');
  }
  const mark = h.events.length;
  const compact = h.post('command', { line: '/compact' });
  await h.event('usage', mark);
  assert.equal((await h.state()).busy, true);
  assert.equal((await h.state()).queueOwner, null);
  assert.equal((await h.post('queue', { sessionId: (await h.state()).currentSessionId, turnId: 'command', id: 'q-command', text: '不能接入命令' })).status, 409);
  await h.post('abort', {}); await compact;
  await h.post('send', { text: 'slow' });
  await until(async () => !!(await h.state()).queueOwner, '用户轮次归属');
  assert.equal((await h.post('queue', { ...(await h.state()).queueOwner, id: 'q-restart', text: '重启后不自动执行' })).status, 200);
  const closed = new Promise((resolve) => h.child.once('close', resolve));
  h.streams.forEach((stream) => stream.destroy()); h.child.kill(); await closed;
  const restarted = await harness(t, { reuseDir: h.dir });
  assert.equal((await restarted.state()).queued, null);
  assert.equal((await restarted.state()).queueOwner, null);
  assert.equal((await restarted.state()).busy, false);
  assert.equal((await restarted.state()).status, 'aborted');
  await delay(30); assert.equal(restarted.requests.length, 0);
});

test('停止 beforeTurn 与 afterTurn 会取消 Hook 进程，不留下延迟写入，下一轮仍可执行', async (t) => {
  for (const hookName of ['beforeTurn', 'afterTurn']) {
    await t.test(hookName, async (t) => {
      const hook = `"${process.execPath}" -e "const fs=require('node:fs');fs.writeFileSync('hook-started',String(process.pid));const timer=setInterval(()=>{if(fs.existsSync('hook-release')){clearInterval(timer);fs.writeFileSync('hook-late','must not write');console.log('late-hook');}},10)"`;
      const h = await harness(t, { cli: true, configContent: JSON.stringify({ [hookName]: hook }) });
      t.after(() => writeFileSync(path.join(h.workspace, 'hook-release'), '1'));
      await h.post('send', { text: '正常回答' });
      await until(() => existsSync(path.join(h.workspace, 'hook-started')), 'Hook 子进程启动');
      const pid = Number(readFileSync(path.join(h.workspace, 'hook-started'), 'utf8'));
      assert.equal((await h.state()).busy, true);
      assert.equal((await h.post('abort', {})).status, 200);
      await until(async () => !(await h.state()).busy, '停止释放 Hook 与会话锁');
      await until(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'Hook 子进程已终止');
      assert.equal((await h.state()).status, hookName === 'beforeTurn' ? 'aborted' : 'completed', '取消轮末 Hook 不改模型完成结果');
      assert.equal(h.requests.length, hookName === 'beforeTurn' ? 0 : 1);
      assert.ok(h.events.some((event) => event.type === 'command' && event.output?.includes('钩子已停止')));
      writeFileSync(path.join(h.workspace, 'hook-release'), '1');
      await delay(50);
      assert.equal(existsSync(path.join(h.workspace, 'hook-late')), false);
      assert.equal((await h.post('config', { beforeTurn: '', afterTurn: '' })).status, 200);
      const mark = h.events.length;
      await h.post('send', { text: '停止后继续' });
      assert.equal((await h.event('turn_end', mark)).reason, 'completed');
    });
  }
});

test('afterTurn 钩子失败可见且不影响主流程', async (t) => {
  const h = await harness(t, { cli: true, configContent: JSON.stringify({ afterTurn: 'exit 3' }) });
  await h.post('send', { text: '正常回答' });
  await h.event('turn_end');
  const failed = await until(() => h.events.findLast((event) => event.type === 'command' && event.output?.includes('钩子执行失败')), '失败回显');
  assert.match(failed.output, /3/);
  const state = await h.state();
  assert.equal(state.status, 'completed', '钩子失败不改变轮次结果');
});

test('afterTurn 配置经 config 端点持久化与校验', async (t) => {
  const h = await harness(t);
  const saved = await h.post('config', { afterTurn: 'echo done' });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(readFileSync(h.dir + '/data/config.json', 'utf8')).afterTurn, 'echo done');
  const tooLong = await h.post('config', { afterTurn: 'x'.repeat(2001) });
  assert.equal(tooLong.status, 400);
});

test('记忆自动沉淀：模型经 memory_append 工具写入并注入后续轮次', async (t) => {
  const h = await harness(t);
  await h.post('send', { text: '沉淀' });
  const deadline = Date.now() + 5000;
  let approved = false;
  while (Date.now() < deadline) {
    const state = await h.state();
    const pending = state.pending?.[0];
    if (pending) {
      assert.match(pending.preview, /追加到长期记忆/, '沉淀工具走逐次审批');
      await h.post('permission', { id: pending.id, decision: 'allow' });
      approved = true;
    }
    if (state.status === 'completed' && !state.busy) break;
    await delay(20);
  }
  assert.equal(approved, true, '沉淀工具走逐次审批');
  assert.equal(existsSync(path.join(h.dir, 'data', 'memory.md')), true, 'memory.md 真实写入');
  const previousRequests = h.requests.length;
  assert.equal((await h.post('send', { text: '复述' })).status, 200);
  await until(() => {
    const request = h.requests[previousRequests];
    return request && request.messages[0]?.content?.includes('记住 pnpm');
  }, '下轮 system 注入新记忆');
  assert.equal(h.requests[previousRequests].messages.at(-1).content, '复述', '新轮次目标确实已发送');
});

test('beforeTurn 钩子：轮开始前执行、事件与状态经环境变量传递', async (t) => {
  const marker = path.join(tmpdir(), `tcode-hook-before-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  t.after(() => { try { unlinkSync(marker); } catch {} });
  const h = await harness(t, { cli: true, configContent: JSON.stringify({ beforeTurn: `echo "$TCODE_HOOK_EVENT" > '${marker}'` }) });
  await h.post('send', { text: '正常回答' });
  await until(() => existsSync(marker), '钩子写标记文件');
  assert.equal(readFileSync(marker, 'utf8').trim(), 'beforeTurn', '环境变量携带事件名');
  await until(async () => (await h.state()).status === 'completed', '轮次照常完成');
});

test('beforeTurn 钩子的 stdout 回显到会话', async (t) => {
  const h = await harness(t, { cli: true, configContent: JSON.stringify({ beforeTurn: 'echo hook-start' }) });
  await h.post('send', { text: '正常回答' });
  const echoed = await until(() => h.events.findLast((event) => event.type === 'command' && event.output?.includes('轮开始钩子输出：')), '开始钩子回显');
  assert.match(echoed.output, /hook-start/);
  await until(async () => (await h.state()).status === 'completed', '轮次照常完成');
});

test('beforeTurn 钩子失败可见且不阻塞轮次', async (t) => {
  const h = await harness(t, { cli: true, configContent: JSON.stringify({ beforeTurn: 'exit 3' }) });
  await h.post('send', { text: '正常回答' });
  const failed = await until(() => h.events.findLast((event) => event.type === 'command' && event.output?.includes('轮开始钩子执行失败')), '失败回显');
  assert.match(failed.output, /3/);
  await until(async () => (await h.state()).status === 'completed', '失败不阻塞轮次');
});

test('beforeTurn 配置经 config 端点持久化', async (t) => {
  const h = await harness(t);
  const saved = await h.post('config', { beforeTurn: 'echo done' });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(readFileSync(h.dir + '/data/config.json', 'utf8')).beforeTurn, 'echo done');
});

test('Hook 配置可从 state 回读，保存其他权限和重启后保持原命令', async (t) => {
  const h = await harness(t, { cli: true });
  const hooks = { beforeTurn: 'echo before-round', afterTurn: 'echo after-round' };
  const saved = await h.post('config', hooks);
  assert.equal(saved.status, 200);
  for (const [key, command] of Object.entries(hooks)) assert.equal(saved.body.state.config[key], command);
  const permissions = await h.post('config', { approval: 'normal', allowWriteDirs: [h.workspace] });
  assert.equal(permissions.status, 200);
  for (const [key, command] of Object.entries(hooks)) assert.equal((await h.state()).config[key], command);
  h.streams.forEach((stream) => stream.destroy());
  const closed = new Promise((resolve) => h.child.once('close', resolve));
  h.child.kill(); await closed;
  const restarted = await harness(t, { cli: true, reuseDir: h.dir });
  for (const [key, command] of Object.entries(hooks)) assert.equal((await restarted.state()).config[key], command);
});
