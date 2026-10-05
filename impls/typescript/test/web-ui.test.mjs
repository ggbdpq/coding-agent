// 浏览器公共边界：真实页面经 HTTP/SSE 驱动，不访问页面内部函数。
// 使用锁定的本地 Playwright 与 Chromium；两个环境变量可复用已有测试环境。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const pageSource = () => readFileSync(new URL('../src/shell/web.html', import.meta.url), 'utf8');
const initialState = (override = {}) => ({
  ready: true,
  config: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'test-model', protocol: 'auto', contextLimit: 100000, workspace: '/tmp/ui-project', hasApiKey: true, approval: 'normal', allowWriteDirs: [] },
  projects: [{ path: '/tmp/ui-project', name: 'ui-project', available: true, sessionCount: 0 }],
  archivedProjects: [],
  modelProfiles: [], activeModelProfileId: null,
  preferences: { theme: 'dark', fontSize: 16, enterToSend: true },
  capabilities: { commands: [], skills: [], tools: [] }, version: '0.5.0', dataDir: '/tmp/ui-data',
  currentSessionId: 's1', title: '新会话', sessions: [], messages: [], activity: [],
  status: 'idle', busy: false, yolo: false, planMode: false, pending: [], usage: { prompt_tokens: 0, completion_tokens: 0 }, turnId: null, seq: 0,
  ...override,
});

async function withPage(state, routes, verify, { initScript } = {}) {
  const streams = new Set();
  const emit = (event) => { for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`); };
  const reply = (res, body, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer((req, res) => {
    const endpoint = req.url.replace('/t/ui-test', '');
    if (endpoint === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); streams.add(res);
      res.write(`data: ${JSON.stringify({ type: 'hello', model: state.config.model, version: 'test', yolo: state.yolo, state })}\n\n`);
      req.on('close', () => streams.delete(res)); return;
    }
    if (endpoint === '/state') { reply(res, state); return; }
    if (endpoint === '/changes' && !routes[endpoint]) { reply(res, { files: [] }); return; }
    if (routes[endpoint]) {
      let raw = ''; req.on('data', (chunk) => { raw += chunk; });
      req.on('end', async () => {
        try { const result = await routes[endpoint](raw ? JSON.parse(raw) : {}, { emit, state }); reply(res, result); }
        catch (error) { reply(res, { error: error.message }, 400); }
      }); return;
    }
    if (endpoint === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageSource()); return; }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(4000);
    if (initScript) await page.addInitScript(initScript);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/t/ui-test/`);
    await verify(page, { emit, state, streams });
    assert.deepEqual(errors, [], '页面不应出现未处理的 JavaScript 错误');
  } finally {
    await browser.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('通过原生目录选择打开项目，取消选择保留当前工作区', async () => {
  const state = initialState();
  await withPage(state, { '/workspace': ({ workspace }) => {
    assert.equal(workspace, '/tmp/selected-project');
    state.config.workspace = workspace; state.seq++;
    return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('button', { name: '选择项目目录', exact: true }).click({ timeout: 2000 });
    await page.getByText('selected-project · 会话', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '工作区目录', exact: true }).count(), 0);
    await page.getByRole('button', { name: '选择项目目录', exact: true }).click();
    assert.equal(state.config.workspace, '/tmp/selected-project');
    assert.equal(await page.getByText('selected-project · 会话', { exact: true }).isVisible(), true);
  }, { initScript: () => {
    let choices = 0;
    window.__TAURI__ = { core: { invoke: async (command) => {
      if (command !== 'select_workspace') throw new Error('错误的原生目录选择命令');
      return choices++ ? null : '/tmp/selected-project';
    } } };
  } });
});

test('项目导航可切换已打开项目，同时展示该项目会话并提供新任务和设置入口', async () => {
  const state = initialState({ projects: [
    { path: '/tmp/ui-project', name: 'ui-project', available: true, sessionCount: 1 },
    { path: '/tmp/another-project', name: 'another-project', available: true, sessionCount: 1 },
    { path: '/tmp/missing-project', name: 'missing-project', available: false, sessionCount: 0 },
  ] });
  await withPage(state, { '/workspace': ({ workspace }) => {
    state.config.workspace = workspace; state.seq++;
    state.sessions = [{ id: 'another-session', title: '另一个项目的任务', cwd: workspace, mtime: 1 }];
    return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('button', { name: '打开项目 another-project', exact: true }).click({ timeout: 2000 });
    await page.getByRole('button', { name: '打开会话 另一个项目的任务', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开项目 another-project', exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await page.getByRole('button', { name: '打开项目 missing-project', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '新任务', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '设置', exact: true }).isVisible(), true);
    assert.equal(await page.getByText('/tmp/another-project', { exact: true }).filter({ visible: true }).count(), 0, '长路径只在设置详情中展示');
  });
});

test('设置中心独立于工作区，七组可导航且模型保存后能返回工作区', async () => {
  const state = initialState();
  await withPage(state, { '/config': (body) => {
    state.config = { ...state.config, ...body }; delete state.config.apiKey; state.seq++;
    return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    const navigation = page.getByRole('navigation', { name: '设置分组', exact: true });
    for (const name of ['常规', '模型', '权限', '外观', '用量', '技能', '命令']) {
      assert.equal(await navigation.getByRole('button', { name, exact: true }).isVisible(), true);
    }
    assert.equal(await page.getByText('/tmp/ui-data', { exact: true }).isVisible(), true);
    assert.equal(await page.getByText('0.5.0', { exact: true }).isVisible(), true);
    await navigation.getByRole('button', { name: '模型', exact: true }).click();
    await page.getByLabel('模型', { exact: true }).fill('updated-model');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).isVisible(), true);
    assert.equal(await page.getByText('updated-model · 自动识别协议', { exact: true }).isVisible(), true);
  });
});

test('工作区可快捷切换已保存模型，保留会话、消息草稿和用量且配置名称只作为文本', async () => {
  const profile = { id: 'p2', name: '本地 <img src=x onerror="alert(1)">', baseUrl: 'http://127.0.0.1:8081/v1', model: 'second-model', protocol: 'openai', contextLimit: 32000, hasApiKey: true };
  const state = initialState({ modelProfiles: [profile], title: '已有任务', activity: [{ type: 'text', delta: '已有回答', seq: 1 }], usage: { prompt_tokens: 20, completion_tokens: 4 }, seq: 1 });
  let selected;
  await withPage(state, { '/model-profiles/select': (body) => {
    selected = body; state.activeModelProfileId = profile.id; state.config = { ...state.config, ...profile }; state.seq++;
    return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('尚未发送的任务');
    const choice = page.getByRole('combobox', { name: '切换模型配置', exact: true });
    await choice.selectOption(profile.id);
    await page.getByText('second-model · openai', { exact: true }).waitFor();
    assert.deepEqual(selected, { id: 'p2' });
    assert.equal(await page.getByRole('heading', { name: '已有任务', exact: true }).isVisible(), true);
    assert.equal(await page.getByText('已有回答', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '尚未发送的任务');
    assert.equal(await page.getByLabel('会话 Token 用量', { exact: true }).textContent(), '输入 20 · 输出 4 · 共 24 Tokens');
    assert.equal(await choice.locator('option:checked').textContent(), profile.name);
    assert.equal(await page.locator('#model-profile-switch img').count(), 0);
  });
});

test('旧模型可命名保存并激活，未保存模型草稿在设置分组与状态同步后保留', async () => {
  const state = initialState(); let saved;
  await withPage(state, { '/model-profiles/save': (body) => {
    saved = body;
    const profile = { ...body, id: 'saved-one', hasApiKey: true }; delete profile.apiKey; delete profile.useActiveKey;
    state.modelProfiles = [profile]; state.activeModelProfileId = profile.id; state.config = { ...state.config, ...profile }; state.seq++;
    return { ok: true, state };
  } }, async (page, { emit }) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('配置名称', { exact: true }).fill('本地 OpenAI');
    await page.getByLabel('模型', { exact: true }).fill('named-model');
    const navigation = page.getByRole('navigation', { name: '设置分组', exact: true });
    await navigation.getByRole('button', { name: '常规', exact: true }).click();
    await navigation.getByRole('button', { name: '模型', exact: true }).click();
    state.seq = 2; emit({ type: 'state', state });
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'named-model');
    assert.equal(await page.getByLabel('配置名称', { exact: true }).inputValue(), '本地 OpenAI');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    assert.deepEqual(saved, { name: '本地 OpenAI', apiKey: '', baseUrl: 'http://127.0.0.1:8080/v1', model: 'named-model', protocol: 'auto', contextLimit: 100000, useActiveKey: true, sourceModelProfileId: null });
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
    assert.equal(await page.getByRole('combobox', { name: '已保存模型配置', exact: true }).inputValue(), 'saved-one');
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    await page.reload();
    assert.equal(await page.getByRole('combobox', { name: '切换模型配置', exact: true }).inputValue(), 'saved-one');
  });
});

test('其他页面切换活动模型后，未命名草稿不能自动借用新活动配置的隐藏密钥', async () => {
  const other = { id: 'other', name: '其他活动配置', ...initialState().config };
  const state = initialState({ modelProfiles: [other] }); const saves = [];
  await withPage(state, { '/model-profiles/save': (body) => {
    saves.push(body);
    const profile = { ...body, id: 'new-saved', hasApiKey: true }; delete profile.apiKey;
    state.modelProfiles.push(profile); state.activeModelProfileId = profile.id; state.config = { ...state.config, ...profile }; state.seq++;
    return { ok: true, state };
  } }, async (page, { emit }) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('配置名称', { exact: true }).fill('旧模型草稿');
    await page.getByLabel('模型', { exact: true }).fill('draft-model');
    state.activeModelProfileId = other.id; state.config = { ...state.config, ...other }; state.seq++;
    emit({ type: 'state', state });
    await page.getByRole('combobox', { name: '已保存模型配置', exact: true }).locator('option:checked').filter({ hasText: other.name }).waitFor({ state: 'attached' });
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'draft-model');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).and(page.locator(':enabled')).waitFor();
    assert.equal(saves.length, 0, '活动配置 owner 已变化，空白 key 不应触发自动复制');
    await page.getByText('正在编辑未命名配置；当前使用其他活动配置', { exact: false }).waitFor();
    await page.getByLabel('API Key', { exact: true }).fill('draft-own-key');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    assert.equal(saves[0].apiKey, 'draft-own-key'); assert.equal('useActiveKey' in saves[0], false);
  });
});

test('其他页面切换模型时，已保存配置草稿仍编辑原配置并明确当前使用的模型', async () => {
  const first = { id: 'first', name: '原配置', ...initialState().config }, other = { ...first, id: 'other', name: '其他配置', model: 'other-model' };
  const state = initialState({ modelProfiles: [first, other], activeModelProfileId: 'first' }); let saved;
  await withPage(state, { '/model-profiles/save': (body) => {
    saved = body;
    const profile = { ...first, ...body }; delete profile.apiKey;
    state.modelProfiles = [profile, other]; state.activeModelProfileId = profile.id; state.config = { ...state.config, ...profile }; state.seq++;
    return { ok: true, state };
  } }, async (page, { emit }) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('模型', { exact: true }).fill('original-draft-model');
    state.activeModelProfileId = other.id; state.config = { ...state.config, ...other }; state.seq++;
    emit({ type: 'state', state });
    await page.getByText('正在编辑原配置；当前使用其他配置', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'original-draft-model');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    assert.equal(saved.id, 'first'); assert.equal(saved.apiKey, ''); assert.equal('useActiveKey' in saved, false);
    assert.equal(state.activeModelProfileId, 'first');
  });
});

test('新模型配置单独填写密钥，取消可恢复活动配置，保存后能编辑且换端点必须填写新密钥', async () => {
  const first = { id: 'first', name: '已有配置', ...initialState().config };
  const state = initialState({ modelProfiles: [first], activeModelProfileId: first.id }); const saves = [];
  await withPage(state, { '/model-profiles/save': (body) => {
    saves.push(body);
    const profile = { ...body, id: body.id || 'second', hasApiKey: true }; delete profile.apiKey;
    state.modelProfiles = [...state.modelProfiles.filter((item) => item.id !== profile.id), profile];
    state.activeModelProfileId = profile.id; state.config = { ...state.config, ...profile }; state.seq++;
    return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '新建模型配置', exact: true }).click();
    assert.equal(await page.getByLabel('配置名称', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('API 端点', { exact: true }).inputValue(), '');
    await page.getByLabel('配置名称', { exact: true }).fill('取消的草稿');
    await page.getByRole('button', { name: '取消新建', exact: true }).click();
    assert.equal(await page.getByLabel('配置名称', { exact: true }).inputValue(), '已有配置');
    assert.equal(await page.getByRole('combobox', { name: '已保存模型配置', exact: true }).locator('option[value=""]').getAttribute('disabled'), '', '活动配置已命名时不能误显示为未命名');
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
    await page.getByRole('button', { name: '新建模型配置', exact: true }).click();
    await page.getByLabel('配置名称', { exact: true }).fill('第二个模型');
    await page.getByLabel('API 端点', { exact: true }).fill(first.baseUrl);
    await page.getByLabel('模型', { exact: true }).fill('other-model');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    assert.equal(saves.length, 0, '新配置不能默认复制活动密钥，即使端点相同');
    await page.getByLabel('API Key', { exact: true }).fill('second-private-key');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).and(page.locator(':enabled')).waitFor();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    assert.deepEqual(saves[0], { name: '第二个模型', baseUrl: first.baseUrl, model: 'other-model', apiKey: 'second-private-key', protocol: 'auto', contextLimit: 100000 });
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
    await page.getByLabel('模型', { exact: true }).fill('edited-model');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).and(page.locator(':enabled')).waitFor();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    assert.equal(saves[1].id, 'second'); assert.equal(saves[1].apiKey, '');
    await page.getByLabel('API 端点', { exact: true }).fill('http://127.0.0.1:9999/v1');
    await page.getByText('更换 API 端点后需要填写新密钥，已保存的密钥不会自动发往新端点。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    assert.equal(saves.length, 2);
  });
});

test('设置内选择保存配置后填入活动字段并清空旧连接测试结果', async () => {
  const profile = { id: 'anthropic', name: 'Anthropic 本地', baseUrl: 'http://127.0.0.1:8082', model: 'other-model', protocol: 'anthropic', contextLimit: 64000, hasApiKey: true };
  const state = initialState({ modelProfiles: [profile] });
  await withPage(state, {
    '/model/test': () => ({ ok: true, elapsedMs: 12, usage: { prompt_tokens: 1, completion_tokens: 2 } }),
    '/model-profiles/select': ({ id }) => {
      assert.equal(id, profile.id); state.activeModelProfileId = id; state.config = { ...state.config, ...profile }; state.seq++;
      return { ok: true, state };
    },
  }, async (page) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '测试已保存的连接', exact: true }).click();
    await page.getByText('连接成功', { exact: false }).waitFor();
    await page.getByRole('combobox', { name: '已保存模型配置', exact: true }).selectOption(profile.id);
    await page.getByLabel('配置名称', { exact: true }).and(page.locator(':enabled')).waitFor();
    assert.equal(await page.getByLabel('配置名称', { exact: true }).inputValue(), profile.name);
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), profile.model);
    assert.equal(await page.getByRole('combobox', { name: /^协议/ }).inputValue(), 'anthropic');
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
    assert.equal(await page.getByText('连接成功', { exact: false }).isVisible(), false, '旧模型连接结果不能用于新活动模型');
  });
});

test('模型配置保存或切换失败保留编辑草稿、原活动配置和错误反馈', async () => {
  const first = { id: 'first', name: '活动配置', ...initialState().config }, second = { ...first, id: 'second', name: '其他配置', model: 'other-model' };
  const state = initialState({ modelProfiles: [first, second], activeModelProfileId: 'first' });
  await withPage(state, {
    '/model-profiles/save': () => { throw new Error('配置文件保存失败'); },
    '/model-profiles/select': () => { throw new Error('模型切换失败'); },
  }, async (page) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('配置名称', { exact: true }).fill('未保存配置');
    await page.getByLabel('模型', { exact: true }).fill('draft-model');
    await page.getByLabel('API Key', { exact: true }).fill('draft-private-key');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('配置文件保存失败', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'draft-model');
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), 'draft-private-key');
    const choice = page.getByRole('combobox', { name: '已保存模型配置', exact: true });
    await choice.selectOption('second');
    await page.getByText('模型切换失败', { exact: true }).filter({ visible: true }).waitFor();
    assert.equal(await choice.inputValue(), 'first');
    assert.equal(await page.getByLabel('配置名称', { exact: true }).inputValue(), '未保存配置');
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), 'draft-private-key');
  });
});

test('审批等待、连接测试和失联期间，模型切换、新建和保存均禁用', async () => {
  const profile = { id: 'saved', name: '已保存模型', ...initialState().config };
  await withPage(initialState({ modelProfiles: [profile], busy: true, status: 'waiting_approval' }), {}, async (page) => {
    assert.equal(await page.getByRole('combobox', { name: '切换模型配置', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分组', exact: true }).getByRole('button', { name: '模型', exact: true }).click();
    assert.equal(await page.getByRole('combobox', { name: '已保存模型配置', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '新建模型配置', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
  });
  let finish, arrived;
  const started = new Promise((resolve) => { arrived = resolve; });
  await withPage(initialState({ modelProfiles: [profile] }), { '/model/test': () => new Promise((resolve) => { finish = resolve; arrived(); }) }, async (page, { streams }) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '测试已保存的连接', exact: true }).click(); await started;
    assert.equal(await page.getByRole('combobox', { name: '已保存模型配置', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '新建模型配置', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
    finish({ ok: true, elapsedMs: 5, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    await page.getByText('连接成功', { exact: false }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: '已保存模型配置', exact: true }).isDisabled(), false);
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    for (const stream of streams) stream.destroy();
    await page.getByText('连接断开，正在重连', { exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: '切换模型配置', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '模型设置', exact: true }).isDisabled(), true);
  });
});

test('长模型配置名称在390px浅色和深色工作区及设置中不产生横向溢出', async () => {
  const profile = { id: 'long', name: '很长的本地模型配置名称'.repeat(6), ...initialState().config };
  const state = initialState({ modelProfiles: [profile], activeModelProfileId: 'long' });
  await withPage(state, {}, async (page, { emit }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    for (const theme of ['light', 'dark']) {
      state.preferences.theme = theme; state.seq++; emit({ type: 'state', state });
      await page.locator(`html[data-color="${theme}"]`).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '工作区无横向溢出');
      await page.getByRole('button', { name: '模型设置', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '模型设置无横向溢出');
      assert.equal(await page.getByRole('combobox', { name: '已保存模型配置', exact: true }).inputValue(), 'long');
      await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    }
  });
});

test('常规设置可归档非当前项目，刷新后可恢复导航且项目会话保留', async () => {
  const other = { path: '/tmp/another-project', name: 'another-project', available: true, sessionCount: 1 };
  const state = initialState({ projects: [initialState().projects[0], other] });
  await withPage(state, {
    '/projects/archive': ({ workspace, archived }) => {
      assert.equal(workspace, other.path);
      if (archived) { state.projects = state.projects.filter((project) => project.path !== workspace); state.archivedProjects.push(other); }
      else { state.archivedProjects = []; state.projects.push(other); }
      state.seq++; return { ok: true, state };
    },
    '/workspace': ({ workspace }) => {
      state.config.workspace = workspace; state.seq++; state.title = '保留下来的历史任务';
      state.sessions = [{ id: 'preserved', title: '保留下来的历史任务', cwd: workspace, mtime: 1 }];
      return { ok: true, state };
    },
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    assert.equal(await page.getByRole('button', { name: '归档项目 ui-project', exact: true }).count(), 0, '当前项目不能归档');
    await page.getByRole('button', { name: '归档项目 another-project', exact: true }).click();
    await page.getByText('项目已归档，历史会话保留', { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '打开项目 another-project', exact: true }).count(), 0);
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '恢复项目 another-project', exact: true }).click();
    await page.getByText('项目已恢复到导航', { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    await page.getByRole('button', { name: '打开项目 another-project', exact: true }).click();
    await page.getByRole('button', { name: '打开会话 保留下来的历史任务', exact: true }).waitFor();
  });
});

test('项目管理可移除非当前项目记录，历史保留在本机，当前项目无移除按钮', async () => {
  const other = { path: '/tmp/another-project', name: 'another-project', available: true, sessionCount: 2 };
  const state = initialState({ projects: [initialState().projects[0], other] });
  await withPage(state, {
    '/projects/remove': ({ workspace }) => {
      assert.equal(workspace, other.path);
      state.projects = state.projects.filter((project) => project.path !== workspace);
      state.seq++; return { ok: true, state };
    },
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    assert.equal(await page.getByRole('button', { name: '移除记录 ui-project', exact: true }).count(), 0, '当前项目无移除按钮');
    await page.getByRole('button', { name: '移除记录 another-project', exact: true }).click();
    await page.getByText('已移除项目记录，历史会话保留在本机', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开项目 another-project', exact: true }).count(), 0, '移除后项目退出导航');
    assert.equal(await page.getByRole('button', { name: '移除记录 another-project', exact: true }).count(), 0, '移除后按钮消失');
  });
});

test('所有项目搜索展示项目归属与正文摘录，可打开归档会话且不可用目录不能打开', async () => {
  const state = initialState({ seq: 9, sessions: [{ id: 's1', title: '当前项目关键词', cwd: '/tmp/ui-project', mtime: 1 }] });
  let searches = 0, selected;
  const matches = [
    { id: 's1', title: '跨项目任务', cwd: '/tmp/archived-project', mtime: 2, excerpt: '关键词 <img src=x onerror="alert(1)">', archived: true, available: true },
    { id: 'missing', title: '不可用任务', cwd: '/tmp/missing-project', mtime: 1, excerpt: '关键词 <script>alert(1)</script>', archived: false, available: false },
  ];
  await withPage(state, {
    '/sessions/search': ({ query }) => { assert.equal(query, '关键词'); searches++; return { sessions: matches, truncated: false }; },
    '/session/select': (body) => {
      selected = body; state.config.workspace = body.workspace; state.title = '跨项目任务'; state.seq = 1;
      state.activity = [{ type: 'text', delta: '其他项目历史回答', seq: state.seq }];
      return { ok: true, state };
    },
  }, async (page) => {
    const search = page.getByRole('textbox', { name: '搜索会话', exact: true });
    await search.fill('关键词');
    assert.equal(searches, 0, '默认当前项目只做本地标题搜索');
    assert.equal(await page.getByRole('button', { name: '打开会话 当前项目关键词', exact: true }).isVisible(), true);
    await page.getByRole('combobox', { name: '搜索范围', exact: true }).selectOption('all');
    await page.getByText('archived-project · 已归档', { exact: true }).waitFor();
    assert.equal(await page.getByText('关键词 <img src=x onerror="alert(1)">', { exact: true }).isVisible(), true);
    assert.equal(await page.locator('#sessions img, #sessions script').count(), 0, '正文摘录只作为文本');
    assert.equal(await page.getByRole('button', { name: '打开会话 不可用任务', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '打开会话 跨项目任务', exact: true }).click();
    await page.getByText('其他项目历史回答', { exact: true }).waitFor();
    assert.deepEqual(selected, { id: 's1', workspace: '/tmp/archived-project' }, '跨项目选择携带工作区，即使会话 id 与当前相同');
    assert.equal(await search.inputValue(), '关键词');
  });
});

test('归档与恢复后，已有所有项目搜索会更新归档标记', async () => {
  const other = { path: '/tmp/another-project', name: 'another-project', available: true, sessionCount: 1 };
  const state = initialState({ projects: [initialState().projects[0], other] });
  await withPage(state, {
    '/sessions/search': () => ({ sessions: [{ id: 'another', title: '历史任务', cwd: other.path, mtime: 1, excerpt: '搜索关键词', available: true, archived: !!state.archivedProjects.length }], truncated: false }),
    '/projects/archive': ({ archived }) => {
      state.projects = archived ? [state.projects[0]] : [state.projects[0], other]; state.archivedProjects = archived ? [other] : [];
      state.seq++; return { ok: true, state };
    },
  }, async (page) => {
    await page.getByRole('textbox', { name: '搜索会话', exact: true }).fill('关键词');
    await page.getByRole('combobox', { name: '搜索范围', exact: true }).selectOption('all');
    await page.getByRole('navigation', { name: '会话列表', exact: true }).getByText('another-project', { exact: true }).waitFor();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '归档项目 another-project', exact: true }).click();
    await page.getByText('项目已归档，历史会话保留', { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    await page.getByText('another-project · 已归档', { exact: true }).waitFor();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '恢复项目 another-project', exact: true }).click();
    await page.getByText('项目已恢复到导航', { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    await page.getByRole('navigation', { name: '会话列表', exact: true }).getByText('another-project', { exact: true }).waitFor();
    assert.equal(await page.getByText('another-project · 已归档', { exact: true }).count(), 0);
  });
});

test('所有项目搜索忽略旧响应，清空与切回当前项目不会被未完成的搜索覆盖', async () => {
  const state = initialState({ sessions: [{ id: 'local', title: '本地会话', cwd: '/tmp/ui-project', mtime: 1 }] });
  const arrivals = new Map(), replies = new Map();
  await withPage(state, { '/sessions/search': ({ query }) => new Promise((resolve) => {
    replies.set(query, resolve); arrivals.get(query)();
  }) }, async (page) => {
    const search = page.getByRole('textbox', { name: '搜索会话', exact: true }), scope = page.getByRole('combobox', { name: '搜索范围', exact: true });
    await scope.selectOption('all');
    const arrived = new Promise((resolve) => arrivals.set('旧词', resolve));
    await search.fill('旧词'); await arrived;
    const oldResponse = page.waitForResponse((response) => response.request().postDataJSON()?.query === '旧词');
    const newerArrived = new Promise((resolve) => arrivals.set('新词', resolve));
    await search.fill('新词'); await newerArrived;
    replies.get('新词')({ sessions: [{ id: 'new', title: '新结果', cwd: '/tmp/ui-project', available: true, excerpt: '新词' }] });
    await page.getByRole('button', { name: '打开会话 新结果', exact: true }).waitFor();
    replies.get('旧词')({ sessions: [{ id: 'old', title: '旧结果', cwd: '/tmp/ui-project', available: true }] });
    await (await oldResponse).finished();
    assert.equal(await page.getByRole('button', { name: '打开会话 旧结果', exact: true }).count(), 0);

    const clearArrived = new Promise((resolve) => arrivals.set('清空前', resolve));
    await search.fill('清空前'); await clearArrived;
    const clearedResponse = page.waitForResponse((response) => response.request().postDataJSON()?.query === '清空前');
    await search.fill('');
    replies.get('清空前')({ sessions: [{ id: 'old', title: '旧结果', cwd: '/tmp/ui-project', available: true }] });
    await (await clearedResponse).finished();
    await page.getByText('输入关键词搜索所有项目的标题和正文', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开会话 旧结果', exact: true }).count(), 0);

    const scopeArrived = new Promise((resolve) => arrivals.set('本地', resolve));
    await search.fill('本地'); await scopeArrived;
    const scopedResponse = page.waitForResponse((response) => response.request().postDataJSON()?.query === '本地');
    await scope.selectOption('current');
    replies.get('本地')({ sessions: [{ id: 'old', title: '旧结果', cwd: '/tmp/ui-project', available: true }] });
    await (await scopedResponse).finished();
    assert.equal(await page.getByRole('button', { name: '打开会话 本地会话', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '打开会话 旧结果', exact: true }).count(), 0);
  });
});

test('搜索为只读操作，审批等待与失联时结果可见但不可打开，截断提示明确', async () => {
  const state = initialState({ busy: true, status: 'waiting_approval' }); let selects = 0;
  await withPage(state, {
    '/sessions/search': () => ({ sessions: [{ id: 'history', title: '历史命中', cwd: '/tmp/ui-project', available: true, excerpt: '关键词' }], truncated: true }),
    '/session/select': () => { selects++; return { state }; },
  }, async (page, { streams }) => {
    await page.getByRole('textbox', { name: '搜索会话', exact: true }).fill('关键词');
    await page.getByRole('combobox', { name: '搜索范围', exact: true }).selectOption('all');
    await page.getByText('仅展示前 50 个匹配会话，请缩小搜索范围', { exact: true }).waitFor();
    const match = page.getByRole('button', { name: '打开会话 历史命中', exact: true });
    assert.equal(await match.isDisabled(), true);
    for (const stream of streams) stream.end();
    await page.getByText('连接断开，正在重连', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await match.isVisible(), true);
    assert.equal(await match.isDisabled(), true);
    assert.equal(selects, 0);
  });
});

test('归档保存失败可见，操作未完成时禁止再次修改且失败后仍能使用原项目', async () => {
  const other = { path: '/tmp/another-project', name: 'another-project', available: true, sessionCount: 1 };
  const state = initialState({ projects: [initialState().projects[0], other] }); let fail;
  await withPage(state, { '/projects/archive': async () => {
    await new Promise((resolve) => { fail = resolve; }); throw new Error('项目配置保存失败');
  } }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    const archive = page.getByRole('button', { name: '归档项目 another-project', exact: true });
    await archive.click();
    assert.equal(await archive.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '返回工作区', exact: true }).isDisabled(), true);
    fail(); await page.getByText('项目配置保存失败', { exact: true }).waitFor();
    assert.equal(await archive.isEnabled(), true);
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '打开项目 another-project', exact: true }).isEnabled(), true);
  });
});

test('连接测试尚未同步后端 busy 时，已有搜索结果与项目归档立即禁用', async () => {
  const other = { path: '/tmp/another-project', name: 'another-project', available: true, sessionCount: 1 };
  const state = initialState({ projects: [initialState().projects[0], other] }); let finish;
  await withPage(state, {
    '/sessions/search': () => ({ sessions: [{ id: 'other', title: '其他项目任务', cwd: other.path, available: true, excerpt: '关键词' }], truncated: false }),
    '/model/test': async () => { await new Promise((resolve) => { finish = resolve; }); return { ok: true, elapsedMs: 5, usage: {} }; },
  }, async (page) => {
    await page.getByRole('textbox', { name: '搜索会话', exact: true }).fill('关键词');
    await page.getByRole('combobox', { name: '搜索范围', exact: true }).selectOption('all');
    await page.getByRole('button', { name: '打开会话 其他项目任务', exact: true }).waitFor();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '测试已保存的连接', exact: true }).click();
    await page.getByText('正在测试已保存的连接…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开会话 其他项目任务', exact: true, includeHidden: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '打开项目 another-project', exact: true, includeHidden: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '归档项目 another-project', exact: true, includeHidden: true }).isDisabled(), true);
    finish(); await page.getByText('连接成功 · 5 ms · 输入 0 · 输出 0 Tokens', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开会话 其他项目任务', exact: true, includeHidden: true }).isEnabled(), true);
  });
});

test('侧栏可以折叠展开，折叠后的主要入口可到达且窄屏不溢出', async () => {
  await withPage(initialState(), {}, async (page) => {
    const sidebar = page.getByRole('complementary', { name: '项目与会话', exact: true });
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click({ timeout: 2000 });
    assert.equal(await sidebar.isVisible(), false);
    assert.equal(await page.getByRole('button', { name: '展开侧栏', exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('button', { name: '新任务', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    assert.equal(await sidebar.isVisible(), true);
    assert.equal(await page.getByRole('textbox', { name: '搜索会话', exact: true }).evaluate((element) => document.activeElement === element), true);
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('region', { name: '设置中心', exact: true }).waitFor();
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    assert.equal(await sidebar.isVisible(), false, '返回工作区保留折叠状态');
    await page.setViewportSize({ width: 390, height: 780 });
    assert.equal(await page.getByRole('button', { name: '展开侧栏', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '新任务', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '设置', exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    assert.equal(await sidebar.isVisible(), true);
  });
});

test('Cmd/Ctrl+N 复用新任务操作，从设置返回工作区并聚焦消息输入', async () => {
  const state = initialState(); let tasks = 0;
  await withPage(state, { '/session/new': () => {
    state.currentSessionId = 'shortcut-' + ++tasks; state.title = '快捷键新任务 ' + tasks; state.activity = []; state.seq++;
    return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    for (const [index, modifier] of ['Control', 'Meta'].entries()) {
      await page.keyboard.press(modifier + '+n');
      await page.getByRole('heading', { name: '快捷键新任务 ' + (index + 1), exact: true }).waitFor();
      assert.equal(await page.getByRole('region', { name: '设置中心', exact: true }).isVisible(), false);
      assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).evaluate((element) => document.activeElement === element), true);
    }
    assert.equal(tasks, 2);
  });
});

test('Cmd/Ctrl+K 展开折叠的侧栏并聚焦会话搜索，也可从设置返回搜索', async () => {
  await withPage(initialState({ sessions: [{ id: 's1', title: '排查错误', cwd: '/tmp/ui-project', mtime: 1 }] }), {}, async (page) => {
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click({ timeout: 2000 });
    await page.keyboard.press('Control+k');
    const search = page.getByRole('textbox', { name: '搜索会话', exact: true });
    await search.waitFor();
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
    await search.fill('排查');
    assert.equal(await page.getByRole('button', { name: '打开会话 排查错误', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.keyboard.press('Meta+k');
    assert.equal(await page.getByRole('region', { name: '设置中心', exact: true }).isVisible(), false);
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
  });
});

test('Cmd/Ctrl+, 打开设置中心，已在设置时不会覆盖未保存的模型草稿', async () => {
  await withPage(initialState(), {}, async (page) => {
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click({ timeout: 2000 });
    await page.keyboard.press('Control+,');
    await page.getByRole('region', { name: '设置中心', exact: true }).waitFor();
    await page.getByRole('navigation', { name: '设置分组', exact: true }).getByRole('button', { name: '模型', exact: true }).click();
    await page.getByLabel('模型', { exact: true }).fill('unsaved-model');
    await page.keyboard.press('Meta+,');
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'unsaved-model');
    assert.equal(await page.getByRole('heading', { name: '模型', exact: true }).isVisible(), true);
  });
});

test('Cmd/Ctrl+B 可折叠和展开侧栏，同时保持正在输入的消息', async () => {
  await withPage(initialState(), {}, async (page) => {
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('尚未发送的消息');
    await input.press('Control+b');
    assert.equal(await page.getByRole('complementary', { name: '项目与会话', exact: true }).isVisible(), false);
    assert.equal(await input.inputValue(), '尚未发送的消息');
    await input.press('Meta+b');
    assert.equal(await page.getByRole('complementary', { name: '项目与会话', exact: true }).isVisible(), true);
    assert.equal(await input.inputValue(), '尚未发送的消息');
  });
});

test('新任务快捷键不能绕过审批等待或尚未同步后端状态的连接测试锁', async () => {
  let newTasks = 0;
  const approvalState = initialState({ title: '审批中的任务', busy: true, status: 'waiting_approval', pending: [{ type: 'permission', id: 'p1', tool: 'write', preview: '等待写入批准' }] });
  await withPage(approvalState, { '/session/new': () => { newTasks++; return { state: approvalState }; } }, async (page) => {
    await page.getByText('等待写入批准', { exact: true }).waitFor();
    await page.keyboard.press('Control+n'); await page.keyboard.press('Meta+n');
    assert.equal(newTasks, 0, '审批期间的快捷键不应发送新任务请求');
    assert.equal(await page.getByRole('heading', { name: '审批中的任务', exact: true }).isVisible(), true);
    assert.equal(await page.getByText('等待写入批准', { exact: true }).isVisible(), true);
  });
  let finish;
  await withPage(initialState(), {
    '/model/test': async () => {
      await new Promise((resolve) => { finish = resolve; });
      return { ok: true, elapsedMs: 5, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
    '/session/new': () => { newTasks++; return { state: initialState() }; },
  }, async (page) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click({ timeout: 2000 });
    await page.getByLabel('模型', { exact: true }).fill('测试期间的草稿');
    await page.getByRole('button', { name: '测试已保存的连接', exact: true }).click();
    await page.getByText('正在测试已保存的连接…', { exact: true }).waitFor();
    await page.keyboard.press('Control+n'); await page.keyboard.press('Meta+n');
    await page.keyboard.press('Control+k'); await page.keyboard.press('Meta+,');
    assert.equal(newTasks, 0, '本地测试锁应在收到后端 busy 状态前阻止新任务请求');
    assert.equal(await page.getByRole('region', { name: '设置中心', exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), '测试期间的草稿');
    finish();
    await page.getByText('连接成功 · 5 ms · 输入 1 · 输出 1 Tokens', { exact: true }).waitFor();
  });
});

test('模型连接测试只使用已保存配置，测试中禁用保存且成功显示耗时用量并保留草稿', async () => {
  const state = initialState(); let finish, request;
  await withPage(state, { '/model/test': async (body, { emit }) => {
    request = body; state.busy = true; state.status = 'running'; state.seq++;
    emit({ type: 'state', state });
    await new Promise((resolve) => { finish = resolve; });
    state.busy = false; state.status = 'idle'; state.seq++;
    return { ok: true, elapsedMs: 123, usage: { prompt_tokens: 2, completion_tokens: 1 }, state };
  } }, async (page) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click({ timeout: 2000 });
    await page.getByLabel('模型', { exact: true }).fill('draft-model');
    await page.getByLabel('API Key', { exact: true }).fill('unsaved-draft-key');
    await page.getByRole('button', { name: '测试已保存的连接', exact: true }).click();
    await page.getByText('正在测试已保存的连接…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '测试已保存的连接', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
    assert.deepEqual(request, {}, '测试不发送模型设置草稿');
    finish();
    await page.getByText('连接成功 · 123 ms · 输入 2 · 输出 1 Tokens', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'draft-model');
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), 'unsaved-draft-key');
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isEnabled(), true);
    assert.equal(state.activity.length, 0);
  });
});

test('模型连接测试可取消，取消后恢复操作并保留未保存的模型草稿', async () => {
  const state = initialState(); let cancel;
  await withPage(state, {
    '/model/test': async (_, { emit }) => {
      state.busy = true; state.status = 'running'; state.seq++; emit({ type: 'state', state });
      await new Promise((_, reject) => { cancel = () => reject(new Error('请求已中止')); });
    },
    '/abort': (_, { emit }) => {
      state.busy = false; state.status = 'idle'; state.seq++; emit({ type: 'state', state });
      cancel(); return { ok: true, state };
    },
  }, async (page) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click({ timeout: 2000 });
    await page.getByLabel('模型', { exact: true }).fill('draft-after-cancel');
    await page.getByRole('button', { name: '测试已保存的连接', exact: true }).click();
    await page.getByText('正在测试已保存的连接…', { exact: true }).waitFor();
    await page.getByRole('button', { name: '取消测试', exact: true }).click();
    await page.getByText('已取消连接测试', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '测试已保存的连接', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '取消测试', exact: true }).isVisible(), false);
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'draft-after-cancel');
  });
});

test('连接测试失败显示服务提供的错误，模型表单和已有会话仍可继续使用', async () => {
  const state = initialState({ activity: [{ type: 'user', text: '已有任务', seq: 1 }, { type: 'text', delta: '已有回答', seq: 2 }], seq: 2 });
  await withPage(state, { '/model/test': () => { throw new Error('连接失败：上游返回已脱敏错误'); } }, async (page) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click({ timeout: 2000 });
    await page.getByRole('button', { name: '测试已保存的连接', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '连接失败：上游返回已脱敏错误' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '测试已保存的连接', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    assert.equal(await page.getByText('已有回答', { exact: true }).isVisible(), true);
  });
});

test('滚动技能设置后切换常规设置，标题和当前项目从顶部可见且技能草稿保留', async () => {
  await withPage(initialState(), {}, async (page) => {
    await page.setViewportSize({ width: 1000, height: 500 });
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    const navigation = page.getByRole('navigation', { name: '设置分组', exact: true });
    await navigation.getByRole('button', { name: '技能', exact: true }).click();
    await page.getByRole('button', { name: '新建技能', exact: true }).click();
    await page.getByRole('textbox', { name: '技能文件名', exact: true }).fill('draft.md');
    await page.getByRole('textbox', { name: '技能正文', exact: true }).fill('# 未保存草稿\n保留正在编辑的内容');
    const content = page.getByRole('region', { name: '设置中心', exact: true }).getByRole('main');
    await content.hover({ position: { x: 20, y: 180 } });
    await page.mouse.wheel(0, 700);
    await page.waitForFunction(() => document.querySelector('[aria-label="设置中心"] main').scrollTop > 0);
    await navigation.getByRole('button', { name: '常规', exact: true }).click();
    const heading = page.getByRole('heading', { name: '常规', exact: true });
    const bounds = await heading.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y < 100, '新设置组的标题应从顶部可见');
    assert.equal(await content.evaluate((element) => element.scrollTop), 0);
    assert.equal(await page.getByRole('heading', { name: '当前项目', exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel('技能正文', { exact: true }).inputValue(), '# 未保存草稿\n保留正在编辑的内容');
  });
});

test('常规与外观偏好保存后刷新保留，并改变主题字号和消息发送按键', async () => {
  const state = initialState(); let received;
  await withPage(state, {
    '/preferences': (body) => { state.preferences = body; state.seq++; return { ok: true, state }; },
    '/send': ({ text }) => { received = text; return { ok: true }; },
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    await page.getByLabel('Enter 发送消息', { exact: true }).uncheck();
    await page.getByRole('button', { name: '保存常规设置', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '外观', exact: true }).click();
    await page.getByLabel('主题', { exact: true }).selectOption('light');
    await page.getByLabel('消息字号', { exact: true }).selectOption('18');
    await page.getByRole('button', { name: '保存外观设置', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    await page.reload();
    assert.equal(await page.locator('body').evaluate((body) => getComputedStyle(body).color), 'rgb(35, 42, 54)');
    assert.equal(await page.getByRole('log', { name: '会话记录' }).evaluate((log) => getComputedStyle(log).fontSize), '18px');
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('消息一'); await input.press('Enter');
    assert.equal(await input.inputValue(), '消息一\n');
    await input.press('Control+Enter');
    await page.waitForFunction(() => document.querySelector('[aria-label="消息"]').value === '');
    assert.equal(received, '消息一');
  });
});

test('权限设置可保存默认审批和通过选择器添加的额外目录，刷新后保留', async () => {
  const state = initialState(); let saved;
  await withPage(state, { '/config': (body) => {
    saved = body; state.config = { ...state.config, ...body }; state.seq++;
    return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '权限', exact: true }).click();
    await page.getByLabel('默认审批方式', { exact: true }).selectOption('never');
    await page.getByRole('button', { name: '添加免审批目录', exact: true }).click();
    await page.getByText('/tmp/extra-project', { exact: true }).waitFor();
    await page.getByRole('button', { name: '保存权限设置', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    assert.deepEqual(saved, { approval: 'never', allowWriteDirs: ['/tmp/extra-project'] });
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '权限', exact: true }).click();
    assert.equal(await page.getByLabel('默认审批方式', { exact: true }).inputValue(), 'never');
    assert.equal(await page.getByText('/tmp/extra-project', { exact: true }).isVisible(), true);
  }, { initScript: () => { window.__TAURI__ = { core: { invoke: async () => '/tmp/extra-project' } }; } });
});

test('用量页展示已记录会话的输入输出汇总，并可刷新', async () => {
  let total = 150;
  await withPage(initialState(), { '/usage': () => ({ sessions: 3, projects: 2, inputTokens: 120, outputTokens: total - 120, totalTokens: total }) }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '用量', exact: true }).click();
    await page.getByText('150 Tokens', { exact: true }).waitFor();
    assert.equal(await page.getByText('120 输入', { exact: true }).isVisible(), true);
    assert.equal(await page.getByText('30 输出', { exact: true }).isVisible(), true);
    assert.equal(await page.getByText('3 个会话 · 2 个项目', { exact: true }).isVisible(), true);
    total = 200;
    await page.getByRole('button', { name: '刷新用量', exact: true }).click();
    await page.getByText('200 Tokens', { exact: true }).waitFor();
  });
});

test('命令页展示实际命令与工具，命令可填入工作区后执行', async () => {
  const state = initialState({ capabilities: {
    commands: [{ name: 'help', usage: '/help', description: '查看所有可用命令' }],
    tools: [{ name: 'read', description: '读取本地文件' }], skills: [],
  } }); let line;
  await withPage(state, { '/command': (body) => { line = body.line; state.activity.push({ type: 'command', output: '命令帮助已显示', seq: ++state.seq }); return { state, output: '命令帮助已显示' }; } }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '命令', exact: true }).click();
    assert.equal(await page.getByText('查看所有可用命令', { exact: true }).isVisible(), true);
    assert.equal(await page.getByText('读取本地文件', { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '填入 /help', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '/help');
    await page.getByRole('textbox', { name: '消息', exact: true }).press('Enter');
    await page.getByText('命令帮助已显示', { exact: true }).waitFor();
    assert.equal(line, '/help');
  });
});

test('技能页可读取并修改实际技能，也能新建项目技能，刷新后保留', async () => {
  const state = initialState({ capabilities: { commands: [], tools: [], skills: [{ name: 'review.md', description: '审查当前改动', path: '/tmp/ui-project/.tcode/skills/review.md', scope: 'project' }] } });
  const skills = new Map([['review.md', '# 审查\n\n<script>安全地显示为文本</script>']]);
  await withPage(state, {
    '/skills?scope=project&name=review.md': () => ({ name: 'review.md', content: skills.get('review.md') }),
    '/skills?scope=project&name=new-skill.md': () => ({ name: 'new-skill.md', content: skills.get('new-skill.md') }),
    '/skills': (body) => {
      skills.set(body.name, body.content); state.seq++;
      if (!state.capabilities.skills.some((skill) => skill.name === body.name)) state.capabilities.skills.push({ name: body.name, description: body.content.split('\n')[0], scope: body.scope, path: '/tmp/ui-project/.tcode/skills/' + body.name });
      return { ok: true, state };
    },
  }, async (page) => {
    const openSkills = async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
      await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '技能', exact: true }).click();
    };
    await openSkills();
    await page.getByRole('button', { name: '编辑技能 review.md（项目）', exact: true }).click();
    await page.getByRole('textbox', { name: '技能正文', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '技能正文', exact: true }).inputValue(), '# 审查\n\n<script>安全地显示为文本</script>');
    await page.getByRole('textbox', { name: '技能正文', exact: true }).fill('# 逐项审查\n保留必要验证');
    await page.getByRole('button', { name: '保存技能', exact: true }).click();
    await page.getByText('技能已保存，下次任务会读取最新内容', { exact: true }).waitFor();
    assert.equal(skills.get('review.md'), '# 逐项审查\n保留必要验证');
    await page.getByRole('button', { name: '新建技能', exact: true }).click();
    await page.getByLabel('技能文件名', { exact: true }).fill('new-skill.md');
    await page.getByRole('textbox', { name: '技能正文', exact: true }).fill('# 新技能\n测试先行');
    await page.getByRole('button', { name: '保存技能', exact: true }).click();
    await page.getByText('技能已保存，下次任务会读取最新内容', { exact: true }).waitFor();
    await page.reload(); await openSkills();
    await page.getByRole('button', { name: '编辑技能 new-skill.md（项目）', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '技能正文', exact: true }).inputValue(), '# 新技能\n测试先行');
  });
});

test('缺少模型配置时能保存配置并开始聊天，API Key 不读回', async () => {
  let saved;
  const state = initialState({ ready: false, configError: '请先配置模型', config: { baseUrl: '', model: '', protocol: 'auto', contextLimit: 100000, workspace: '/tmp/ui-project', hasApiKey: false } });
  await withPage(state, { '/config': (body) => {
    saved = body; state.ready = true; state.config = { ...body, hasApiKey: true }; delete state.config.apiKey; delete state.configError;
    return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('region', { name: '设置中心', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '测试已保存的连接', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('API Key', { exact: true }).getAttribute('type'), 'password');
    await page.getByLabel('API Key', { exact: true }).fill('test-key-not-for-display');
    await page.getByLabel('API 端点', { exact: true }).fill('http://127.0.0.1:8080/v1');
    await page.getByLabel('模型', { exact: true }).fill('test-model');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    assert.equal(saved.apiKey, 'test-key-not-for-display');
    assert.equal(await page.getByRole('textbox', { name: '消息' }).isEnabled(), true);
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
    assert.equal((await page.locator('body').innerText()).includes('test-key-not-for-display'), false);
  });
});

test('侧栏可搜索、切换和重命名会话，刷新后恢复同一会话', async () => {
  const state = initialState({ title: '排查加载问题', sessions: [
    { id: 's1', title: '排查加载问题', label: '加载失败', cwd: '/tmp/ui-project', mtime: 1, usage: { prompt_tokens: 0, completion_tokens: 0 } },
    { id: 's2', title: '优化列表', label: '改善列表性能', cwd: '/tmp/ui-project', mtime: 2, usage: { prompt_tokens: 0, completion_tokens: 0 } },
  ], activity: [{ type: 'user', text: '加载失败', seq: 1 }], seq: 1 });
  await withPage(state, {
    '/session/select': ({ id }) => { state.currentSessionId = id; state.title = state.sessions.find((s) => s.id === id).title; state.activity = [{ type: 'user', text: '改善列表性能', seq: ++state.seq }, { type: 'text', delta: '历史回答已恢复', seq: ++state.seq }]; return { ok: true, state }; },
    '/session/rename': ({ id, title }) => { state.sessions.find((s) => s.id === id).title = title; state.title = title; state.seq++; return { ok: true, state }; },
    '/session/new': () => { state.currentSessionId = 's3'; state.title = '新会话'; state.activity = []; state.sessions.unshift({ id: 's3', title: '新会话', cwd: '/tmp/ui-project', mtime: 3, usage: { prompt_tokens: 0, completion_tokens: 0 } }); state.seq++; return { ok: true, state }; },
  }, async (page) => {
    await page.getByRole('textbox', { name: '搜索会话' }).fill('优化列表', { timeout: 2000 });
    assert.equal(await page.getByRole('button', { name: '打开会话 排查加载问题', exact: true }).count(), 0);
    await page.getByRole('button', { name: '打开会话 优化列表', exact: true }).click();
    await page.getByRole('heading', { name: '优化列表', exact: true }).waitFor();
    assert.equal(await page.getByText('历史回答已恢复', { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '重命名 优化列表', exact: true }).click();
    await page.getByRole('textbox', { name: '会话名称', exact: true }).fill('优化列表性能');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.reload();
    await page.getByRole('heading', { name: '优化列表性能', exact: true }).waitFor();
    assert.equal(state.currentSessionId, 's2');
    assert.equal(await page.getByText('历史回答已恢复', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '新任务', exact: true }).click();
    await page.getByRole('heading', { name: '新会话', exact: true }).waitFor();
    assert.equal(await page.getByText('历史回答已恢复', { exact: true }).count(), 0);
  });
});

test('审批等待期间禁止切换，双击审批只提交一次并同步运行状态', async () => {
  let decisions = 0;
  const state = initialState({ status: 'waiting_approval', busy: true, seq: 2,
    sessions: [{ id: 's1', title: '新会话', cwd: '/tmp/ui-project', mtime: 1 }, { id: 's2', title: '历史会话', cwd: '/tmp/ui-project', mtime: 2 }],
    pending: [{ type: 'permission', id: 'p1', tool: 'write', preview: '写入 README.md' }],
    activity: [{ type: 'user', text: '修改文档', seq: 1 }, { type: 'tool_call', call_id: 'call1', name: 'write', args: { file: 'README.md' }, seq: 2 }],
  });
  await withPage(state, { '/permission': async () => {
    decisions++; await new Promise((resolve) => setTimeout(resolve, 80));
    state.pending = []; state.status = 'running';
    return { ok: true };
  } }, async (page) => {
    await page.getByText('等待审批', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开会话 历史会话', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '新任务', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '模型设置', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('checkbox', { name: '全部免审批' }).isDisabled(), true);
    await page.getByRole('button', { name: '允许', exact: true }).dblclick();
    await page.getByText('正在执行', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(decisions, 1);
    assert.equal(await page.getByRole('button', { name: '允许', exact: true }).count(), 0);
  });
});

test('任务运行中可以浏览设置，修改控件保持禁用，返回后审批仍在', async () => {
  const state = initialState({ status: 'waiting_approval', busy: true, pending: [{ type: 'permission', id: 'p1', tool: 'write', preview: '等待批准写入' }] });
  await withPage(state, {}, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    assert.equal(await page.getByRole('checkbox', { name: 'Enter 发送消息', exact: true }).isDisabled(), true);
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '模型', exact: true }).click();
    assert.equal(await page.getByLabel('API 端点', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '测试已保存的连接', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    assert.equal(await page.getByText('等待批准写入', { exact: true }).isVisible(), true);
  });
});

test('回答支持 Markdown 和代码块，模型输出不能注入 HTML 或脚本链接', async () => {
  const answer = '# 实施结果\n\n**已完成**，检查 `npm test`。\n\n- 保留用户改动\n- 验证通过\n\n```js\nconsole.log("<safe>");\n```\n\n[官方资料](https://example.com/docs) [恶意链接](javascript:alert(1))\n\n<img src=x onerror="alert(1)"><script>alert(1)</script>';
  await withPage(initialState({ activity: [{ type: 'user', text: '完成后给出说明', seq: 1 }, { type: 'text', delta: answer, seq: 2 }, { type: 'turn_end', reason: 'completed', seq: 3 }], status: 'completed', seq: 3 }), {}, async (page) => {
    await page.getByRole('heading', { name: '实施结果', exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await page.locator('strong').filter({ hasText: '已完成' }).count(), 1);
    assert.equal(await page.getByRole('listitem').count(), 2);
    assert.equal(await page.locator('pre code').innerText(), 'console.log("<safe>");');
    assert.equal(await page.getByRole('link', { name: '官方资料', exact: true }).getAttribute('href'), 'https://example.com/docs');
    assert.equal(await page.getByRole('link', { name: '恶意链接', exact: true }).count(), 0);
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.locator('script').count(), 1, '仅页面自己的脚本可以存在');
  });
});

test('Git 变更逐文件展示，可暂存并提交，diff 转义为纯文本', async () => {
  const diff = 'diff --git a/src/demo.ts b/src/demo.ts\nindex 123..456 100644\n--- a/src/demo.ts\n+++ b/src/demo.ts\n@@ -1 +1 @@\n-before\n+after <img src=x>\n';
  const calls = [];
  let files = [{ path: 'src/demo.ts', staged: false, untracked: false, deleted: false, revertable: false, diff }];
  await withPage(initialState({ usage: { prompt_tokens: 120, completion_tokens: 30 } }), {
    '/changes': () => ({ files }),
    '/changes/stage': (body) => { calls.push(['stage', body]); files = files.map((file) => ({ ...file, staged: true })); return { ok: true, changes: { files } }; },
    '/changes/commit': (body) => { calls.push(['commit', body]); files = []; return { ok: true, changes: { files } }; },
  }, async (page) => {
    await page.getByText('输入 120 · 输出 30 · 共 150 Tokens', { exact: true }).waitFor({ timeout: 2000 });
    await page.getByRole('button', { name: '查看变更', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Git 变更' });
    await panel.waitFor();
    await panel.getByText('src/demo.ts', { exact: true }).click();
    assert.equal(await panel.getByText('+after <img src=x>', { exact: true }).isVisible(), true);
    assert.equal(await panel.getByText('-before', { exact: true }).isVisible(), true);
    assert.equal(await panel.locator('img').count(), 0, 'diff 内容必须是纯文本，不能出现 HTML 元素');
    await panel.getByRole('button', { name: '暂存 src/demo.ts', exact: true }).click();
    await panel.getByText('已暂存', { exact: true }).waitFor({ timeout: 2000 });
    assert.deepEqual(calls.at(0), ['stage', { paths: ['src/demo.ts'], staged: true }]);
    await panel.getByRole('textbox', { name: '提交说明', exact: true }).fill('提交说明');
    await page.getByRole('button', { name: '提交已暂存', exact: true }).click();
    await panel.getByText('已提交', { exact: true }).waitFor({ timeout: 2000 });
    assert.deepEqual(calls.at(1), ['commit', { message: '提交说明' }]);
    await panel.getByText('没有 Git 变更', { exact: true }).waitFor({ timeout: 2000 });
    await page.getByRole('button', { name: '关闭变更', exact: true }).click();
    assert.equal(await panel.isVisible(), false);
  });
});

test('工具结果按 call_id 关联，完整输出在刷新后仍可查看', async () => {
  const state = initialState({ seq: 5, status: 'completed', activity: [
    { type: 'user', text: '执行两项检查', seq: 1 },
    { type: 'tool_call', call_id: 'first', name: 'read', args: { path: 'a.txt' }, seq: 2 },
    { type: 'tool_call', call_id: 'second', name: 'bash', args: { command: 'echo b' }, seq: 3 },
    { type: 'tool_result', call_id: 'second', name: 'bash', summary: 'B 第一行', output: 'B 第一行\nB 完整末行', ms: 20, seq: 4 },
    { type: 'tool_result', call_id: 'first', name: 'read', summary: 'A 第一行', output: 'A 第一行\nA 完整末行', ms: 10, seq: 5 },
  ] });
  await withPage(state, {}, async (page) => {
    await page.getByText('read · 10 ms', { exact: true }).click();
    const read = page.locator('details').filter({ has: page.getByText('read · 10 ms', { exact: true }) });
    assert.equal(await read.getByText('A 第一行\nA 完整末行', { exact: true }).isVisible(), true);
    assert.equal(await read.getByText('B 第一行\nB 完整末行', { exact: true }).count(), 0);
    await page.reload();
    await page.getByText('bash · 20 ms', { exact: true }).click();
    assert.equal(await page.getByText('B 第一行\nB 完整末行', { exact: true }).isVisible(), true);
  });
});

test('390px 窄屏没有横向溢出，Shift+Enter 换行和 Enter 发送可用', async () => {
  let received;
  await withPage(initialState({ sessions: [{ id: 's1', title: '这是一个很长的会话标题用于验证侧栏宽度边界', cwd: '/tmp/ui-project', mtime: 1 }] }), { '/send': (body) => { received = body.text; return { ok: true }; } }, async (page) => {
    await page.setViewportSize({ width: 390, height: 780 });
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.waitFor();
    await input.fill('第一行'); await input.press('Shift+Enter'); await input.pressSequentially('第二行');
    assert.equal(await input.inputValue(), '第一行\n第二行');
    await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('[aria-label="消息"]').value === '');
    assert.equal(received, '第一行\n第二行');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.equal(await page.getByRole('button', { name: '设置', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '返回工作区', exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  });
});

test('连接中断时保留任务状态，重连后恢复待审批而不重复历史', async () => {
  const state = initialState({ busy: true, status: 'waiting_approval', seq: 1, activity: [{ type: 'user', text: '运行中的任务', seq: 1 }], pending: [{ type: 'permission', id: 'p1', tool: 'write', preview: '等待批准写入' }] });
  await withPage(state, {}, async (page, { streams }) => {
    await page.getByText('等待审批', { exact: true }).waitFor();
    for (const stream of streams) stream.end();
    await page.getByText('连接断开，正在重连', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).isDisabled(), true);
    await page.getByText('等待审批', { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByText('运行中的任务', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '允许', exact: true }).count(), 1);
  });
});

test('保存失败与 diff 读取错误提示可见，仍能审阅已经读取的变更', async () => {
  const state = initialState({ storageError: '本地会话保存失败，请检查数据目录的空间和权限' });
  await withPage(state, { '/changes': () => ({ files: [{ path: 'demo.txt', staged: false, untracked: false, deleted: false, revertable: false, diff: 'diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new\n' }], error: '差异超过限制，仅展示前段' }) }, async (page) => {
    await page.getByText('本地会话保存失败，请检查数据目录的空间和权限', { exact: true }).waitFor({ timeout: 2000 });
    await page.getByRole('button', { name: '查看变更', exact: true }).click();
    await page.getByText('差异超过限制，仅展示前段', { exact: true }).waitFor();
    await page.getByText('demo.txt', { exact: true }).click();
    assert.equal(await page.getByText('+new', { exact: true }).isVisible(), true);
  });
});

test('斜杠命令结果随会话同步，刷新后仍可查看且不重复', async () => {
  const state = initialState();
  await withPage(state, { '/command': () => {
    const output = '/help 可用命令：/new /resume /yolo';
    state.activity.push({ type: 'command', output, seq: ++state.seq });
    return { output, state };
  } }, async (page) => {
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('/help');
    await page.getByRole('textbox', { name: '消息', exact: true }).press('Enter');
    await page.getByText('/help 可用命令：/new /resume /yolo', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('/help 可用命令：/new /resume /yolo', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await page.getByText('/help 可用命令：/new /resume /yolo', { exact: true }).count(), 1);
  });
});

test('模型设置列出已保存配置并可删除非活动项，活动配置禁用删除', async () => {
  const active = { id: 'p-active', name: '活动配置', ...initialState().config };
  const spare = { id: 'p-spare', name: '备用配置', baseUrl: 'https://b.example/anthropic', model: 'm2', protocol: 'anthropic', contextLimit: 80000 };
  const state = initialState({ modelProfiles: [active, spare], activeModelProfileId: 'p-active' });
  await withPage(state, { '/model-profiles/delete': ({ id }) => {
    assert.equal(id, 'p-spare');
    state.modelProfiles = state.modelProfiles.filter((profile) => profile.id !== id);
    state.seq++; return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const removeActive = page.getByRole('button', { name: '删除配置 活动配置', exact: true });
    const removeSpare = page.getByRole('button', { name: '删除配置 备用配置', exact: true });
    await removeActive.waitFor();
    assert.equal(await removeActive.isDisabled(), true, '正在使用的配置不能删除');
    assert.equal(await removeSpare.isDisabled(), false);
    await removeSpare.click();
    await page.getByText('已删除配置 备用配置', { exact: true }).waitFor();
    assert.equal(await removeSpare.count(), 0, '删除后列表行消失');
    assert.equal(await page.getByRole('combobox', { name: '已保存模型配置', exact: true }).locator('option').count(), 2, '下拉只剩占位与活动配置');
  });
});

test('模型设置可获取已保存配置的模型列表，模型输入保持自由填写', async () => {
  const state = initialState();
  await withPage(state, { '/model/discover': () => ({ models: ['m-a', 'm-b'] }) }, async (page) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await page.getByText('发现 2 个模型，模型输入框可下拉选择', { exact: true }).waitFor();
    const options = await page.locator('#model-options option').evaluateAll((nodes) => nodes.map((node) => node.value));
    assert.deepEqual(options, ['m-a', 'm-b']);
    await page.getByLabel('模型', { exact: true }).fill('custom-model');
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'custom-model', '候选列表不能锁死输入框');
  });
});

test('模型设置可导出脱敏 JSON 并导入配置文件，跳过原因可见', async () => {
  const state = initialState();
  await withPage(state, {
    '/model-profiles/export': () => ({ exportedAt: '2026-10-05T00:00:00Z', profiles: [{ name: '已保存', baseUrl: 'https://a.example/v1', model: 'm', protocol: 'openai', contextLimit: 1000, hasApiKey: true }] }),
    '/model-profiles/import': (body) => {
      assert.deepEqual(body.profiles.map((profile) => profile.name), ['朋友分享的配置']);
      state.modelProfiles.push({ id: 'imported-1', name: '朋友分享的配置', baseUrl: 'https://b.example/v1', model: 'm2', protocol: 'openai', contextLimit: 2000, hasApiKey: false });
      state.seq++; return { ok: true, imported: 1, skipped: ['重复端点：端点已存在'], state };
    },
  }, async (page) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出配置', exact: true }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^tcode-model-profiles-\d{4}-\d{2}-\d{2}\.json$/);
    await page.getByText('已导出 1 个配置（不含 API Key）', { exact: true }).waitFor();
    await page.getByLabel('选择配置文件', { exact: true }).setInputFiles({
      name: 'share.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ profiles: [{ name: '朋友分享的配置', baseUrl: 'https://b.example/v1', model: 'm2', protocol: 'openai', contextLimit: 2000 }] })),
    });
    await page.getByText('已导入 1 个配置；跳过 1 个：重复端点：端点已存在', { exact: true }).waitFor();
    await page.getByRole('button', { name: '删除配置 朋友分享的配置', exact: true }).waitFor();
  });
});

test('用量页展示账户余额并可刷新，失败信息留在卡片内', async () => {
  const state = initialState();
  let calls = 0;
  await withPage(state, {
    '/usage/balance': () => {
      calls++;
      if (calls === 1) return { balance: { isAvailable: true, currency: 'CNY', totalBalance: '82.39', grantedBalance: '0.00', toppedUpBalance: '82.39' }, checkedAt: '2026-10-06T00:00:00Z' };
      return { error: 'HTTP 401：invalid key' };
    },
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '用量', exact: true }).click();
    await page.getByText('82.39 CNY', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查询余额', exact: true }).click();
    await page.getByText('查询失败', { exact: true }).waitFor();
    await page.getByText('HTTP 401：invalid key', { exact: true }).waitFor();
  });
});
