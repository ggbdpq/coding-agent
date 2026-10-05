// 已确认边界①②③：真实 CLI、配置、HTTP/SSE、审批与外部协议请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('等待本地配置测试服务超时');
}

async function fixture(t, { originalKey = 'profile-original-key', secondKey = 'profile-anthropic-key', errorResponse = false, rejectModel = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tcode-profiles-')));
  const data = path.join(root, 'data'), workspace = path.join(root, 'project');
  for (const directory of [data, workspace]) mkdirSync(directory);
  const requests = [], events = [];
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/openai/chat/completions', '/anthropic/v1/messages'].includes(req.url)) {
      res.writeHead(400).end('unexpected protocol route'); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), anthropic = req.url === '/anthropic/v1/messages';
    requests.push({ route: req.url, body, headers: req.headers });
    const user = body.messages.findLast((message) => message.role === 'user')?.content;
    if (errorResponse || user === 'error') { res.writeHead(401).end(originalKey + ' ' + secondKey); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (user === 'slow') { res.write(': waiting\n\n'); return; }
    if (anthropic) {
      send({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } });
      send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Anthropic OK' } });
      send({ type: 'message_delta', usage: { output_tokens: 2 } });
      res.end('data: {"type":"message_stop"}\n\n');
    } else if (user === 'write' && !body.messages.some((message) => message.role === 'tool')) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write-profile', function: { name: 'write', arguments: JSON.stringify({ file_path: 'result.txt', content: 'approved' }) } }] } }] });
      res.end('data: [DONE]\n\n');
    } else {
      send({ choices: [{ delta: { content: 'OpenAI OK' } }] });
      send({ usage: { prompt_tokens: 3, completion_tokens: 2 }, choices: [] });
      res.end('data: [DONE]\n\n');
    }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${provider.address().port}`;
  const configFile = path.join(data, 'config.json');
  writeFileSync(configFile, JSON.stringify({ apiKey: originalKey, baseUrl: endpoint + '/openai', model: 'original-model',
    protocol: 'openai', contextLimit: 40000, workspace, projects: [workspace], approval: 'normal', allowWriteDirs: [workspace],
    preferences: { theme: 'light', fontSize: 18, enterToSend: false } }));
  const env = { ...process.env, TCODE_DATA_DIR: data };
  for (const key of ['TCODE_API_KEY', 'TCODE_BASE_URL', 'TCODE_MODEL', 'TCODE_PROTOCOL', 'TCODE_CONTEXT_LIMIT', 'TCODE_APPROVAL', 'TCODE_ALLOW_WRITE']) delete env[key];
  let child, url, stream;
  async function start(overrides = {}) {
    // 公开 provider 插件拒绝构造某个模型；其余请求仍走内置协议客户端。
    const host = `
      import path from 'node:path';
      import { loadConfig } from '${new URL('../src/kernel/config.ts', import.meta.url)}';
      import { createApp } from '${new URL('../src/kernel/app.ts', import.meta.url)}';
      import { Registry } from '${new URL('../src/kernel/registry.ts', import.meta.url)}';
      import { builtinPlugins } from '${new URL('../src/plugins/index.ts', import.meta.url)}';
      import { SessionStore } from '${new URL('../src/core/session.ts', import.meta.url)}';
      import { startWeb } from '${new URL('../src/shell/web.ts', import.meta.url)}';
      const config = loadConfig({ allowIncomplete: true, desktop: true }); process.chdir(config.workspace);
      const plugins = builtinPlugins.map((plugin) => plugin.kind === 'provider' ? { ...plugin, create: (candidate) => {
        if (candidate.model === 'reject-model') throw new Error('provider rejected credential ' + candidate.apiKey);
        return plugin.create(candidate);
      } } : plugin);
      const app = createApp(config, new Registry().registerAll(plugins), { yolo: false,
        freshMessages: () => [{ role: 'system', content: '公开插件测试宿主' }], store: new SessionStore(path.join(config.tcodeDir, 'sessions')) });
      await startWeb(app);
    `;
    const args = rejectModel ? ['--input-type=module', '-e', host] : [fileURLToPath(new URL('../bin/tcode.js', import.meta.url)), 'web', '--desktop'];
    child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', (chunk) => output += chunk); child.stderr.on('data', (chunk) => errors += chunk);
    url = await until(() => {
      if (child.exitCode !== null) throw new Error('CLI 退出：' + errors);
      return output.match(/http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]+\//)?.[0];
    });
    const before = events.length;
    stream = get(url + 'events', (response) => {
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const line = block.split('\n').find((value) => value.startsWith('data:'));
          if (line) events.push(JSON.parse(line.slice(5)));
        }
      });
    });
    stream.on('error', () => {});
    await until(() => events.slice(before).some((event) => event.type === 'hello'));
  }
  async function stop() {
    stream?.destroy(); child.kill();
    await Promise.race([new Promise((resolve) => child.once('close', resolve)), delay(200)]);
  }
  await start();
  t.after(async () => { await stop(); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); });
  return { root, data, workspace, configFile, endpoint, requests, events, originalKey, secondKey,
    state: async () => (await fetch(url + 'state')).json(),
    post: async (route, body = {}) => { const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const text = await response.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = { error: text }; } return { status: response.status, body: parsed }; },
    get: async (route) => { const response = await fetch(url + route); const text = await response.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = { error: text }; } return { status: response.status, body: parsed }; },
    restart: async (overrides) => { await stop(); await start(overrides); },
  };
}

const currentProfile = (h) => ({ name: '本地 OpenAI', baseUrl: h.endpoint + '/openai', model: 'original-model', protocol: 'openai', contextLimit: 40000, useActiveKey: true, sourceModelProfileId: null });
const secondProfile = (h) => ({ name: 'Anthropic 开发', baseUrl: h.endpoint + '/anthropic', model: 'anthropic-model', protocol: 'anthropic', contextLimit: 80000, apiKey: h.secondKey });
const noKeys = (value) => { const text = JSON.stringify(value); assert.equal(text.includes('profile-original-key'), false); assert.equal(text.includes('profile-anthropic-key'), false); };

// Slice 1：把现有单组配置明确命名保存，HTTP/SSE 只返回凭证存在标记。
test('命名保存当前模型配置，保留工作区与会话并通过 SSE 发布脱敏列表', async (t) => {
  const h = await fixture(t), before = await h.state(), eventMark = h.events.length;
  const response = await h.post('model-profiles/save', currentProfile(h));
  assert.equal(response.status, 200);
  const state = response.body.state;
  assert.equal(state.modelProfiles.length, 1);
  const profile = state.modelProfiles[0];
  assert.ok(profile.id); assert.equal(state.activeModelProfileId, profile.id);
  assert.deepEqual({ ...profile, id: 'known' }, { id: 'known', name: '本地 OpenAI', baseUrl: h.endpoint + '/openai', model: 'original-model', protocol: 'openai', contextLimit: 40000, hasApiKey: true });
  assert.equal(state.currentSessionId, before.currentSessionId); assert.deepEqual(state.messages, before.messages);
  assert.equal(state.config.workspace, before.config.workspace); assert.deepEqual(state.preferences, before.preferences);
  assert.deepEqual(state.config.allowWriteDirs, before.config.allowWriteDirs); assert.deepEqual(state.usage, before.usage);
  const persisted = JSON.parse(readFileSync(h.configFile, 'utf8'));
  assert.equal(persisted.activeModelProfileId, profile.id);
  assert.equal(persisted.modelProfiles[0].apiKey, '', '明文密钥不能落盘');
  assert.equal(persisted.modelProfiles[0].keyRef, profile.id);
  await until(() => h.events.slice(eventMark).some((event) => event.type === 'state' && event.state.activeModelProfileId === profile.id));
  noKeys(response.body); noKeys(h.events); noKeys(await h.state());
});

// Slice 2：保存第二个协议后快速切回；连接请求与续聊使用所选配置，重启仍有效。
test('两组模型可切换且使用各自协议、模型与凭证，续聊和重启保留项目历史', async (t) => {
  const h = await fixture(t);
  const original = await h.post('model-profiles/save', currentProfile(h));
  const firstId = original.body.state.activeModelProfileId;
  await h.post('send', { text: '已有任务' });
  await until(async () => !(await h.state()).busy && (await h.state()).messages.length === 2);
  const before = await h.state();
  const second = await h.post('model-profiles/save', secondProfile(h));
  assert.equal(second.status, 200);
  const secondId = second.body.state.activeModelProfileId;
  assert.notEqual(firstId, secondId); assert.equal(second.body.state.modelProfiles.length, 2);
  assert.equal((await h.post('model/test')).status, 200);
  const anthropic = h.requests.at(-1);
  assert.equal(anthropic.route, '/anthropic/v1/messages');
  assert.equal(anthropic.headers['x-api-key'], 'profile-anthropic-key'); assert.equal(anthropic.body.model, 'anthropic-model');
  assert.deepEqual(anthropic.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }]);
  const switched = await h.post('model-profiles/select', { id: firstId });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.state.activeModelProfileId, firstId); assert.equal(switched.body.state.config.model, 'original-model');
  assert.equal(switched.body.state.currentSessionId, before.currentSessionId); assert.deepEqual(switched.body.state.messages, before.messages);
  assert.deepEqual(switched.body.state.activity, before.activity); assert.deepEqual(switched.body.state.usage, before.usage);
  assert.equal((await h.post('model/test')).status, 200);
  const openai = h.requests.at(-1);
  assert.equal(openai.route, '/openai/chat/completions'); assert.equal(openai.headers.authorization, 'Bearer profile-original-key');
  assert.equal(openai.body.model, 'original-model'); assert.deepEqual(openai.body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
  assert.equal((await h.post('send', { text: '继续任务' })).status, 200);
  await until(async () => !(await h.state()).busy && (await h.state()).messages.length === 4);
  assert.equal(h.requests.at(-1).body.messages.some((message) => message.content === '已有任务'), true);
  const continued = await h.state();
  await h.restart();
  const restored = await h.state();
  assert.equal(restored.activeModelProfileId, firstId); assert.equal(restored.modelProfiles.length, 2);
  assert.equal(restored.config.workspace, before.config.workspace); assert.deepEqual(restored.messages, continued.messages);
  assert.equal((await h.post('model-profiles/select', { id: secondId })).status, 200);
  assert.equal((await h.post('model/test')).status, 200); assert.equal(h.requests.at(-1).headers['x-api-key'], 'profile-anthropic-key');
  noKeys(restored); noKeys(h.events);
});

// Slice 3：兼容原单组设置入口；编辑活动配置后，列表与重启不能保留旧模型。
test('原模型设置同步活动配置，空 Key 留存本组凭证并保留配置名称', async (t) => {
  const h = await fixture(t);
  const first = await h.post('model-profiles/save', currentProfile(h));
  const id = first.body.state.activeModelProfileId;
  const edited = await h.post('config', { model: 'updated-model', apiKey: '', contextLimit: 50000, protocol: 'auto' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.state.activeModelProfileId, id);
  assert.deepEqual(edited.body.state.modelProfiles[0], { id, name: '本地 OpenAI', baseUrl: h.endpoint + '/openai', model: 'updated-model', protocol: 'auto', contextLimit: 50000, hasApiKey: true });
  await h.restart();
  assert.equal((await h.state()).modelProfiles[0].model, 'updated-model');
  assert.equal((await h.post('model-profiles/select', { id })).status, 200);
  assert.equal((await h.post('model/test')).status, 200);
  assert.equal(h.requests.at(-1).body.model, 'updated-model'); assert.equal(h.requests.at(-1).headers.authorization, 'Bearer profile-original-key');
  const named = await h.post('model-profiles/save', { ...currentProfile(h), id, name: '改名', model: 'updated-model', useActiveKey: false, apiKey: '' });
  assert.equal(named.status, 200); assert.equal(named.body.state.modelProfiles.length, 1); assert.equal(named.body.state.modelProfiles[0].name, '改名');
  noKeys(named.body); noKeys(h.events);
});

// Slice 4：环境优先仍适用，但实际模型不同不能标记使用了保存的配置。
test('环境变量改变有效模型时保留列表且清空活动标记，退出覆盖后恢复保存配置', async (t) => {
  const h = await fixture(t);
  const saved = await h.post('model-profiles/save', currentProfile(h));
  const id = saved.body.state.activeModelProfileId;
  const disk = readFileSync(h.configFile, 'utf8');
  const overrides = [
    { TCODE_MODEL: 'environment-model' }, { TCODE_API_KEY: 'environment-only-key' },
    { TCODE_BASE_URL: h.endpoint + '/different' }, { TCODE_PROTOCOL: 'anthropic' }, { TCODE_CONTEXT_LIMIT: '99999' },
  ];
  for (const env of overrides) {
    await h.restart(env); const state = await h.state();
    assert.equal(state.activeModelProfileId, null, '环境覆盖必须与所选配置区分');
    assert.equal(state.modelProfiles[0].id, id); assert.equal(state.modelProfiles[0].model, 'original-model');
    assert.equal(JSON.stringify(state).includes('environment-only-key'), false); noKeys(state);
    assert.equal(readFileSync(h.configFile, 'utf8'), disk, '启动不能把环境值写入持久化预设');
  }
  await h.restart({ TCODE_MODEL: 'original-model', TCODE_API_KEY: 'profile-original-key' });
  assert.equal((await h.state()).activeModelProfileId, id, '相同的有效配置仍可匹配');
  await h.restart(); assert.equal((await h.state()).activeModelProfileId, id);
});

// Slice 5：凭证归属是服务端边界，手写请求也不能把当前 Key 发往新端点。
test('新配置与更换端点需要明确凭证，非法输入不改变活动配置或磁盘', async (t) => {
  const h = await fixture(t);
  const first = await h.post('model-profiles/save', currentProfile(h));
  const firstId = first.body.state.activeModelProfileId;
  const second = await h.post('model-profiles/save', secondProfile(h));
  const secondId = second.body.state.activeModelProfileId;
  const original = readFileSync(h.configFile, 'utf8'), before = await h.state();
  const invalidProfiles = [
    { ...secondProfile(h), apiKey: '' }, { ...secondProfile(h), apiKey: '', useActiveKey: true, baseUrl: h.endpoint + '/new-provider' },
    { ...currentProfile(h), id: firstId, baseUrl: h.endpoint + '/new-provider', useActiveKey: false, apiKey: '' },
    { ...currentProfile(h), id: firstId, useActiveKey: false, apiKey: 123 },
    { ...secondProfile(h), id: 'missing' }, { ...secondProfile(h), id: 1 }, { ...secondProfile(h), name: '' },
    { ...secondProfile(h), name: 'x'.repeat(81) }, { ...secondProfile(h), baseUrl: 'file:///tmp/model' },
    { ...secondProfile(h), baseUrl: 'https://user:password@example.com/v1' }, { ...secondProfile(h), protocol: 'invalid' },
    { ...secondProfile(h), contextLimit: 0 }, { ...secondProfile(h), contextLimit: 1.5 }, { ...secondProfile(h), useActiveKey: 'true' },
  ];
  for (const input of invalidProfiles) {
    const response = await h.post('model-profiles/save', input);
    assert.equal(response.status, 400, `非法配置须拒绝：${JSON.stringify({ ...input, apiKey: '[hidden]' })}`); noKeys(response.body);
    assert.equal(readFileSync(h.configFile, 'utf8'), original); assert.equal((await h.state()).activeModelProfileId, secondId);
  }
  assert.equal((await h.post('model-profiles/select', { id: 1 })).status, 400);
  assert.equal((await h.post('model-profiles/select', { id: 'missing' })).status, 400);
  const endpointChange = await h.post('config', { baseUrl: h.endpoint + '/other', apiKey: '' });
  assert.equal(endpointChange.status, 400); assert.match(endpointChange.body.error, /重新填写/);
  assert.equal(readFileSync(h.configFile, 'utf8'), original); assert.deepEqual((await h.state()).messages, before.messages);
  const updated = await h.post('model-profiles/save', { ...currentProfile(h), id: firstId, useActiveKey: false, apiKey: '' });
  assert.equal(updated.status, 200);
  assert.equal((await h.post('model/test')).status, 200); assert.equal(h.requests.at(-1).headers.authorization, 'Bearer profile-original-key', '编辑非活动配置只能保留自己的凭证');
  await h.post('send', { text: 'error' });
  await until(async () => !(await h.state()).busy && (await h.state()).status === 'error');
  noKeys(h.events); noKeys(await h.state());
});

test('运行中与等待审批时不能保存或切换模型，停止不执行待审批写入', async (t) => {
  const h = await fixture(t);
  const first = await h.post('model-profiles/save', currentProfile(h));
  const id = first.body.state.activeModelProfileId;
  await h.post('config', { allowWriteDirs: [] });
  for (const [text, expected] of [['slow', 'running'], ['write', 'waiting_approval']]) {
    const disk = readFileSync(h.configFile, 'utf8');
    assert.equal((await h.post('send', { text })).status, 200);
    await until(async () => (await h.state()).status === expected);
    assert.equal((await h.post('model-profiles/save', secondProfile(h))).status, 409);
    assert.equal((await h.post('model-profiles/select', { id })).status, 409);
    assert.equal((await h.post('config', { model: 'must-not-save' })).status, 409);
    assert.equal(readFileSync(h.configFile, 'utf8'), disk); assert.equal((await h.state()).activeModelProfileId, id);
    assert.equal((await h.post('abort')).status, 200); await until(async () => !(await h.state()).busy);
  }
  assert.equal(existsSync(path.join(h.workspace, 'result.txt')), false);
  assert.equal((await h.post('model-profiles/save', secondProfile(h))).status, 200);
  assert.equal((await h.post('model/test')).status, 200);
});

test('保存或切换落盘失败保留活动 provider、配置与会话，恢复权限后可继续', async (t) => {
  const h = await fixture(t);
  const first = await h.post('model-profiles/save', currentProfile(h));
  const id = first.body.state.activeModelProfileId;
  await h.post('model-profiles/save', secondProfile(h));
  const disk = readFileSync(h.configFile, 'utf8'), before = await h.state();
  chmodSync(h.data, 0o500); t.after(() => chmodSync(h.data, 0o700));
  for (const [route, input] of [['model-profiles/save', { ...currentProfile(h), id, useActiveKey: false, name: '不能写入' }], ['model-profiles/select', { id }], ['config', { model: 'cannot-save' }]]) {
    const response = await h.post(route, input);
    assert.equal(response.status, 500); noKeys(response.body);
    const state = await h.state();
    assert.equal(state.activeModelProfileId, before.activeModelProfileId); assert.deepEqual(state.modelProfiles, before.modelProfiles);
    assert.deepEqual(state.config, before.config); assert.deepEqual(state.messages, before.messages); assert.deepEqual(state.usage, before.usage);
    assert.equal(readFileSync(h.configFile, 'utf8'), disk);
    assert.equal((await h.post('model/test')).status, 200); assert.equal(h.requests.at(-1).headers['x-api-key'], 'profile-anthropic-key');
  }
  chmodSync(h.data, 0o700);
  assert.equal((await h.post('model-profiles/select', { id })).status, 200);
  assert.equal((await h.post('model/test')).status, 200); assert.equal(h.requests.at(-1).headers.authorization, 'Bearer profile-original-key');
});

test('损坏的持久化协议或错误凭证类型可从设置恢复，读接口不泄露内容', async (t) => {
  for (const invalid of [
    (profile) => ({ ...profile, protocol: 'auto' }), (profile) => ({ ...profile, apiKey: 123 }), (profile) => ({ ...profile, contextLimit: 0 }),
    (profile) => ({ ...profile, baseUrl: 'file:///tmp/provider' }),
  ]) await t.test('非法保存字段', async (t) => {
    const h = await fixture(t);
    const saved = await h.post('model-profiles/save', currentProfile(h));
    const disk = JSON.parse(readFileSync(h.configFile, 'utf8'));
    disk.modelProfiles[0] = invalid(disk.modelProfiles[0]); writeFileSync(h.configFile, JSON.stringify(disk));
    await h.restart(); const state = await h.state();
    assert.equal(state.ready, false); assert.match(state.configError, /格式或字段无效/); assert.deepEqual(state.modelProfiles, []); assert.equal(state.activeModelProfileId, null); noKeys(state);
    const repaired = await h.post('model-profiles/save', { ...currentProfile(h), useActiveKey: false, apiKey: 'profile-original-key' });
    assert.equal(repaired.status, 200); assert.equal(repaired.body.state.configError, undefined);
    assert.notEqual(repaired.body.state.activeModelProfileId, saved.body.state.activeModelProfileId);
  });
});

// Slice 6：服务商回显非活动配置的长 Key 也必须在截断之前隐藏。
test('两个协议的 HTTP 与 SSE 错误在截断前隐藏活动和非活动长凭证', async (t) => {
  for (const protocol of ['openai', 'anthropic']) await t.test(protocol, async (t) => {
    const originalKey = 'long-original-private-' + 'x'.repeat(400), secondKey = 'long-anthropic-private-' + 'y'.repeat(400);
    const h = await fixture(t, { originalKey, secondKey, errorResponse: true });
    const original = await h.post('model-profiles/save', currentProfile(h));
    await h.post('model-profiles/save', secondProfile(h));
    if (protocol === 'openai') await h.post('model-profiles/select', { id: original.body.state.activeModelProfileId });
    const checked = await h.post('model/test');
    assert.equal(checked.status, 502);
    for (const key of [originalKey, secondKey]) assert.equal(JSON.stringify(checked.body).includes(key.slice(0, 120)), false, '错误不得泄露长 Key 的前缀');
    assert.match(checked.body.error, /凭证已隐藏/);
    assert.equal((await h.post('send', { text: 'error' })).status, 200);
    await until(async () => !(await h.state()).busy && (await h.state()).status === 'error');
    for (const key of [originalKey, secondKey]) {
      assert.equal(JSON.stringify(h.events).includes(key.slice(0, 120)), false, 'SSE 不得泄露截断的非活动 Key');
      assert.equal(JSON.stringify(await h.state()).includes(key.slice(0, 120)), false);
    }
  });
});

// Slice 7：provider 构造也可能拒绝配置，必须先验证再落盘，并隐藏尚未保存的 Key。
test('provider 构造失败不落盘、不换活动配置且隐藏新填凭证', async (t) => {
  const h = await fixture(t, { rejectModel: true });
  const original = await h.post('model-profiles/save', currentProfile(h));
  const originalId = original.body.state.activeModelProfileId;
  const disk = JSON.parse(readFileSync(h.configFile, 'utf8'));
  disk.modelProfiles.push({ id: 'rejected-profile', name: '不可用配置', apiKey: 'profile-anthropic-key', baseUrl: h.endpoint + '/anthropic', model: 'reject-model', protocol: 'anthropic', contextLimit: 80000 });
  writeFileSync(h.configFile, JSON.stringify(disk)); await h.restart();
  const persisted = readFileSync(h.configFile, 'utf8'), before = await h.state();
  for (const [route, input] of [
    ['model-profiles/save', { ...secondProfile(h), model: 'reject-model', apiKey: 'brand-new-private-key' }],
    ['model-profiles/select', { id: 'rejected-profile' }],
    ['config', { model: 'reject-model', apiKey: 'brand-new-private-key' }],
  ]) {
    const response = await h.post(route, input);
    assert.equal(response.status, 500); assert.match(response.body.error, /provider rejected/);
    assert.equal(JSON.stringify(response.body).includes('brand-new-private-key'), false, 'provider 拒绝时不能回显新填写的凭证'); noKeys(response.body);
    assert.equal(readFileSync(h.configFile, 'utf8'), persisted); assert.equal((await h.state()).activeModelProfileId, originalId);
    assert.deepEqual((await h.state()).modelProfiles, before.modelProfiles); assert.deepEqual((await h.state()).messages, before.messages);
    assert.equal((await h.post('model/test')).status, 200); assert.equal(h.requests.at(-1).headers.authorization, 'Bearer profile-original-key');
  }
});

test('短活动 Key 是非活动长 Key 的前缀时，两个协议均隐藏整段凭证', async (t) => {
  for (const protocol of ['openai', 'anthropic']) await t.test(protocol, async (t) => {
    const shortKey = 'shared-private-prefix-', longKey = shortKey + 'private-suffix-'.repeat(35);
    const h = await fixture(t, { originalKey: protocol === 'openai' ? shortKey : longKey,
      secondKey: protocol === 'anthropic' ? shortKey : longKey, errorResponse: true });
    const original = await h.post('model-profiles/save', currentProfile(h));
    await h.post('model-profiles/save', secondProfile(h));
    if (protocol === 'openai') await h.post('model-profiles/select', { id: original.body.state.activeModelProfileId });
    const response = await h.post('model/test');
    assert.equal(response.status, 502);
    assert.equal(JSON.stringify(response.body).includes(shortKey), false);
    assert.equal(JSON.stringify(response.body).includes('private-suffix-'), false, '短 Key 不能先替换而暴露长 Key 的后缀');
    assert.match(response.body.error, /凭证已隐藏/);
  });
});

// Slice 8：明确沿用凭证也须核对来源，不能借到迟到 SSE 之前刚切换的配置 Key。
test('沿用当前凭证须匹配活动来源，迟到、缺失或非法来源不能复制另一个配置的 Key', async (t) => {
  const h = await fixture(t);
  const original = await h.post('model-profiles/save', currentProfile(h));
  const firstId = original.body.state.activeModelProfileId;
  const second = await h.post('model-profiles/save', { ...secondProfile(h), baseUrl: h.endpoint + '/openai', protocol: 'openai' });
  assert.equal(second.status, 200);
  const secondId = second.body.state.activeModelProfileId;
  const before = await h.state(), disk = readFileSync(h.configFile, 'utf8'), requestCount = h.requests.length;
  const missing = { ...currentProfile(h), name: '不能借用' }; delete missing.sourceModelProfileId;
  for (const input of [
    { ...currentProfile(h), sourceModelProfileId: null },
    { ...currentProfile(h), sourceModelProfileId: firstId },
    missing,
    { ...currentProfile(h), sourceModelProfileId: 1 },
    { ...currentProfile(h), sourceModelProfileId: { id: secondId } },
  ]) {
    const response = await h.post('model-profiles/save', input);
    assert.equal(response.status, 400, '凭证来源与当前活动配置不符时必须拒绝');
    assert.match(response.body.error, /活动配置已改变，请重新填写密钥/); noKeys(response.body);
    const state = await h.state();
    assert.equal(state.activeModelProfileId, secondId); assert.deepEqual(state.modelProfiles, before.modelProfiles);
    assert.deepEqual(state.config, before.config); assert.deepEqual(state.messages, before.messages);
    assert.equal(readFileSync(h.configFile, 'utf8'), disk); assert.equal(h.requests.length, requestCount, '拒绝请求不能发往 provider');
  }
  assert.equal((await h.post('model/test')).status, 200);
  assert.equal(h.requests.at(-1).headers.authorization, 'Bearer profile-anthropic-key', '拒绝陈旧请求后仍使用原活动配置的 provider');
  const copied = await h.post('model-profiles/save', { ...currentProfile(h), name: '明确复制第二组', sourceModelProfileId: secondId });
  assert.equal(copied.status, 200);
  assert.equal((await h.post('model/test')).status, 200); assert.equal(h.requests.at(-1).headers.authorization, 'Bearer profile-anthropic-key');
  noKeys(copied.body); noKeys(h.events);
});

// Slice 6：删除非活动配置持久化，活动配置与未知配置拒绝删除。
test('删除非活动模型配置持久化且不影响活动配置，活动与未知配置拒绝删除', async (t) => {
  const h = await fixture(t);
  const first = await h.post('model-profiles/save', currentProfile(h));
  const firstId = first.body.state.activeModelProfileId;
  const second = await h.post('model-profiles/save', secondProfile(h));
  const secondId = second.body.state.activeModelProfileId;
  assert.notEqual(firstId, secondId);
  const deleted = await h.post('model-profiles/delete', { id: firstId });
  assert.equal(deleted.status, 200);
  const state = deleted.body.state;
  assert.equal(state.modelProfiles.some((profile) => profile.id === firstId), false);
  assert.equal(state.activeModelProfileId, secondId, '删除非活动配置不影响活动配置');
  assert.equal(state.config.model, 'anthropic-model');
  assert.equal(JSON.parse(readFileSync(h.configFile, 'utf8')).modelProfiles.some((profile) => profile.id === firstId), false, '删除必须持久化');
  assert.equal((await h.state()).modelProfiles.length, 1);
  const refuse = await h.post('model-profiles/delete', { id: secondId });
  assert.equal(refuse.status, 400);
  assert.match(refuse.body.error, /正在使用/);
  assert.equal((await h.post('model-profiles/delete', { id: 'no-such-id' })).status, 400);
  assert.equal((await h.post('model-profiles/delete', { id: null })).status, 400);
  await h.restart();
  assert.equal((await h.state()).modelProfiles.length, 1, '重启后删除仍生效');
});

// Slice 7：导出结构上不含任何密钥；导入忽略传入密钥、跳过重复端点、不激活不改动活动配置。
test('导出模型配置为脱敏 JSON：含 hasApiKey 标记，不含任何密钥明文', async (t) => {
  const h = await fixture(t);
  await h.post('model-profiles/save', currentProfile(h));
  await h.post('model-profiles/save', secondProfile(h));
  const disk = readFileSync(h.configFile, 'utf8');
  const response = await h.get('model-profiles/export');
  assert.equal(response.status, 200);
  assert.ok(response.body.exportedAt);
  assert.equal(response.body.profiles.length, 2);
  const first = response.body.profiles.find((profile) => profile.name === '本地 OpenAI');
  assert.deepEqual(first, { name: '本地 OpenAI', baseUrl: h.endpoint + '/openai', model: 'original-model', protocol: 'openai', contextLimit: 40000, hasApiKey: true });
  noKeys(response.body);
  assert.equal(readFileSync(h.configFile, 'utf8'), disk, '导出不能改变配置');
});

test('导入校验：忽略传入密钥、跳过重复端点与非法条目、不激活不改变活动配置，持久化且重启生效', async (t) => {
  const h = await fixture(t);
  const first = await h.post('model-profiles/save', currentProfile(h));
  const activeId = first.body.state.activeModelProfileId;
  const before = await h.state();
  const response = await h.post('model-profiles/import', { profiles: [
    { name: '重复端点', baseUrl: h.endpoint + '/openai/', model: 'x', protocol: 'openai', contextLimit: 1000 },
    { name: '新端点配置', baseUrl: h.endpoint + '/fresh', model: 'fresh-model', protocol: 'openai', contextLimit: 20000, apiKey: 'must-be-ignored' },
    { name: '坏地址', baseUrl: 'ftp://bad', model: 'y', protocol: 'openai', contextLimit: 1000 },
    { name: '', baseUrl: h.endpoint + '/anon', model: 'z', protocol: 'openai', contextLimit: 1000 },
  ] });
  assert.equal(response.status, 200);
  assert.equal(response.body.imported, 1);
  assert.deepEqual(response.body.skipped, ['重复端点：端点已存在', '坏地址：端点须为不含用户名和密码的 HTTP(S) 地址', '未命名：配置名称须为 1 至 80 个字符']);
  const state = response.body.state;
  const imported = state.modelProfiles.find((profile) => profile.name === '新端点配置');
  assert.ok(imported); assert.equal(imported.hasApiKey, false, '传入的密钥必须被忽略');
  assert.equal(state.modelProfiles.length, before.modelProfiles.length + 1);
  assert.equal(state.activeModelProfileId, activeId, '导入不能改变活动配置');
  assert.equal(state.config.model, 'original-model');
  const persisted = JSON.parse(readFileSync(h.configFile, 'utf8'));
  assert.equal(persisted.modelProfiles.length, state.modelProfiles.length);
  assert.equal(JSON.stringify(persisted).includes('must-be-ignored'), false, '密钥不能落盘');
  await h.restart();
  assert.equal((await h.state()).modelProfiles.some((profile) => profile.name === '新端点配置'), true);
});

test('导入非数组或超过 50 条拒绝', async (t) => {
  const h = await fixture(t);
  assert.equal((await h.post('model-profiles/import', { profiles: 'nope' })).status, 400);
  const fiftyOne = Array.from({ length: 51 }, (_, i) => ({ name: `配置 ${i}`, baseUrl: `${h.endpoint}/p${i}`, model: 'm', protocol: 'openai', contextLimit: 1000 }));
  assert.equal((await h.post('model-profiles/import', { profiles: fiftyOne })).status, 400);
});

// Slice 8：密钥入 macOS 钥匙串——config.json 不落明文，切换/删除/回退与读取失败均可见。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const keyringService = (tcodeDir) => 'tcode:' + createHash('sha256').update(tcodeDir).digest('hex').slice(0, 16);
function keyringSet(service, account, value) {
  execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
}
function keyringGet(service, account) {
  try { return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}
function keyringDelete(service, account) {
  try { execFileSync('security', ['delete-generic-password', '-s', service, '-a', account]); } catch {}
}

test('保存模型配置密钥写入钥匙串，config.json 只留引用不落明文，重启后连接测试仍用该密钥', async (t) => {
  const h = await fixture(t);
  const service = keyringService(h.data);
  t.after(() => { keyringDelete(service, 'active'); });
  const saved = await h.post('model-profiles/save', currentProfile(h));
  assert.equal(saved.status, 200);
  const profile = saved.body.state.modelProfiles[0];
  const persisted = JSON.parse(readFileSync(h.configFile, 'utf8'));
  assert.equal(persisted.modelProfiles[0].apiKey, '', '明文密钥不能落盘');
  assert.equal(persisted.modelProfiles[0].keyRef, profile.id, '落盘的是钥匙串引用');
  assert.equal(JSON.stringify(persisted).includes('profile-original-key'), false);
  assert.equal(keyringGet(service, profile.id), 'profile-original-key', '密钥必须写入钥匙串');
  assert.equal(saved.body.state.config.hasApiKey, true);
  await h.restart();
  const state = await h.state();
  assert.equal(state.config.hasApiKey, true, '重启后从钥匙串恢复活动密钥');
  assert.equal((await h.post('model/test')).status, 200, '重启后连接测试用钥匙串里的密钥');
  assert.equal(h.requests.at(-1).headers.authorization, 'Bearer profile-original-key');
  assert.equal(JSON.stringify(await h.state()).includes('profile-original-key'), false, '读接口不回显钥匙串密钥');
});

test('切换配置按引用从钥匙串读取密钥，两组明文都不落盘；删除配置清理钥匙串条目', async (t) => {
  const h = await fixture(t);
  const service = keyringService(h.data);
  const first = await h.post('model-profiles/save', currentProfile(h));
  const firstId = first.body.state.activeModelProfileId;
  const second = await h.post('model-profiles/save', secondProfile(h));
  const secondId = second.body.state.activeModelProfileId;
  t.after(() => { keyringDelete(service, firstId); keyringDelete(service, secondId); });
  assert.equal(JSON.parse(readFileSync(h.configFile, 'utf8')).modelProfiles.every((profile) => profile.apiKey === '' && profile.keyRef), true);
  assert.equal(keyringGet(service, firstId), 'profile-original-key');
  assert.equal(keyringGet(service, secondId), h.secondKey);
  assert.equal((await h.post('model-profiles/select', { id: firstId })).status, 200);
  assert.equal((await h.post('model/test')).status, 200);
  assert.equal(h.requests.at(-1).headers.authorization, 'Bearer profile-original-key');
  const deleted = await h.post('model-profiles/delete', { id: secondId });
  assert.equal(deleted.status, 200);
  assert.equal(keyringGet(service, secondId), null, '删除配置必须清理钥匙串条目');
});

test('TCODE_KEYSTORE=off 回退明文落盘（兼容无钥匙串平台），行为与旧版一致', async (t) => {
  const h = await fixture(t);
  await h.restart({ TCODE_KEYSTORE: 'off' });
  const saved = await h.post('model-profiles/save', currentProfile(h));
  assert.equal(saved.status, 200);
  const persisted = JSON.parse(readFileSync(h.configFile, 'utf8'));
  assert.equal(persisted.modelProfiles[0].apiKey, 'profile-original-key', '回退模式下密钥明文落盘');
  assert.equal(persisted.modelProfiles[0].keyRef, undefined);
});

test('钥匙串引用失效时重启后错误可见且不产生明文', async (t) => {
  const h = await fixture(t);
  const service = keyringService(h.data);
  const saved = await h.post('model-profiles/save', currentProfile(h));
  const profileId = saved.body.state.activeModelProfileId;
  keyringDelete(service, profileId);
  t.after(() => { keyringDelete(service, profileId); });
  await h.restart();
  const state = await h.state();
  assert.match(state.configError, /钥匙串/, '顶层密钥读取失败必须可见');
  assert.equal(state.config.hasApiKey, false);
  assert.equal(JSON.stringify(state).includes('profile-original-key'), false);
  const select = await h.post('model-profiles/select', { id: profileId });
  assert.equal(select.status, 200);
  const probe = await h.post('model/test');
  assert.equal(probe.status, 400);
  assert.match(probe.body.error, /钥匙串/);
});
