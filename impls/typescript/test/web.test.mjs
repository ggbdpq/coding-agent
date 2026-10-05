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
    const value = fn();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`等待超时：${label}`);
}

async function harness(t, { cli = false, unconfigured = false, reuseDir = undefined, configContent = undefined, summaryMode = 'success' } = {}) {
  const dir = reuseDir ?? mkdtempSync(path.join(tmpdir(), 'tcode-workbench-'));
  const workspace = path.join(dir, 'project');
  const requests = [];
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
    if (user === 'error') { res.writeHead(400).end('deliberate provider failure test-key'); return; }
    if (['slow', 'slow A', 'slow B'].includes(user)) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': wait\n\n'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const hasResult = body.messages.some((m) => m.role === 'tool');
    if (user === 'write' && !hasResult) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write-1', function: { name: 'write', arguments: JSON.stringify({ file_path: 'result.txt', content: 'approved content' }) } }] } }] });
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
  };
  const child = spawn(process.execPath, [cli ? 'bin/tcode.js' : 'test/web-fixture.mjs', ...(cli ? ['web'] : [])], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { url, post, state, event, events, workspace, dir, child, endpoint, streams, requests };
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
