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
        console.error('[MOCK] hit', endpoint);
        try { const result = await routes[endpoint](raw ? JSON.parse(raw) : {}, { emit, state }); reply(res, result); }
        catch (error) { console.error('[MOCK] handler error', endpoint, error.message); reply(res, { error: error.message }, error.status ?? 400); }
      }); return;
    }
    console.error('[MOCK] UNROUTED', req.method, endpoint);
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

test('运行中可写草稿并排队一条，刷新恢复队列，取消只恢复空白草稿且迟到响应不抹掉新输入', async () => {
  const owner = { sessionId: 's1', turnId: 'owner-1' };
  const state = initialState({ title: '正在完善 README', busy: true, status: 'running', queueOwner: owner, queued: null, seq: 1 });
  const text = '下一条 <img src=x onerror="alert(1)">';
  let release, received, cancelled, acknowledge;
  const accepted = new Promise((resolve) => { acknowledge = resolve; });
  await withPage(state, {
    '/queue': async (body) => {
      received = body; acknowledge();
      await new Promise((resolve) => { release = resolve; });
      state.queued = { id: body.id, text: body.text, sessionId: owner.sessionId }; state.seq++;
      return { ok: true, state };
    },
    '/queue/cancel': (body) => {
      cancelled = body; state.queued = null; state.seq++;
      return { ok: true, state };
    },
  }, async (page) => {
    await page.getByRole('heading', { name: state.title, exact: true }).waitFor();
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    assert.equal(await input.isEnabled(), true, '主轮运行时仍可写下一条草稿');
    await input.fill(text);
    await page.getByRole('button', { name: '排队下一条', exact: true }).click();
    await accepted;
    await input.fill('响应返回前写的新草稿');
    release();
    const queue = page.getByRole('region', { name: '排队指令', exact: true });
    await queue.getByText(text, { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '响应返回前写的新草稿');
    assert.equal(await queue.locator('img').count(), 0, '队列文本不作为 HTML');
    assert.deepEqual({ text: received.text, sessionId: received.sessionId, turnId: received.turnId }, { text, ...owner });
    assert.match(received.id, /^[A-Za-z0-9_-]{1,80}$/);
    assert.equal(await page.getByRole('button', { name: '排队下一条', exact: true }).isDisabled(), true, '只允许一个待执行条目');
    await page.reload();
    await queue.getByText(text, { exact: true }).waitFor();
    await page.getByRole('button', { name: '取消排队', exact: true }).click();
    await queue.waitFor({ state: 'hidden' });
    assert.deepEqual(cancelled, { id: received.id });
    assert.equal(await input.inputValue(), text, '取消后的文本恢复到空白输入框供修改');
  });
});

test('审查范围只筛选本轮快照文件，HEAD 差异保留用户修改且提交仍覆盖仓库已暂存文件', async () => {
  const files = [
    { path: 'agent.txt', staged: false, untracked: false, deleted: false, revertable: true, diff: '+Agent 编辑\n+用户原有笔记\n' },
    { path: 'user.txt', staged: true, untracked: false, deleted: false, revertable: false, diff: '+用户自己编辑\n' },
  ];
  const calls = [];
  await withPage(initialState(), {
    '/changes': () => ({ files }),
    '/changes/commit': (body) => { calls.push(body); return { changes: { files: [] } }; },
  }, async (page) => {
    await page.getByRole('button', { name: '查看变更', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Git 变更', exact: true });
    await panel.getByText('user.txt', { exact: true }).waitFor();
    await panel.getByRole('combobox', { name: '审查范围', exact: true }).selectOption('snapshots');
    assert.equal(await panel.getByText('agent.txt', { exact: true }).isVisible(), true);
    assert.equal(await panel.getByText('user.txt', { exact: true }).count(), 0);
    await panel.getByText('agent.txt', { exact: true }).click();
    assert.equal(await panel.getByText('+用户原有笔记', { exact: true }).isVisible(), true);
    assert.match(await panel.getByRole('note').textContent(), /用户.*修改/);
    assert.match(await panel.getByRole('note').textContent(), /命令|bash/);
    assert.match(await panel.getByRole('note').textContent(), /提交.*全部已暂存/);
    await panel.getByRole('textbox', { name: '提交说明', exact: true }).fill('提交仓库已暂存');
    assert.equal(await panel.getByRole('button', { name: '提交已暂存', exact: true }).isEnabled(), true, '隐藏的已暂存文件仍属于提交范围');
    await panel.getByRole('button', { name: '提交已暂存', exact: true }).click();
    await panel.getByText('本轮没有可展示的快照文件', { exact: true }).waitFor();
    assert.deepEqual(calls, [{ message: '提交仓库已暂存' }]);
    await panel.getByRole('combobox', { name: '审查范围', exact: true }).selectOption('all');
    await panel.getByText('没有 Git 变更', { exact: true }).waitFor();
  });
});

test('排队已接受但响应失败后取消，再排同一文本必须生成新请求而不丢草稿', async () => {
  const state = initialState({ title: '等待首轮结束', busy: true, status: 'running', queueOwner: { sessionId: 's1', turnId: 'owner-1' }, queued: null, seq: 1 });
  const requests = [];
  await withPage(state, {
    '/queue': (body, { emit }) => {
      requests.push(body);
      state.queued = { id: body.id, text: body.text, sessionId: body.sessionId }; state.seq++;
      emit({ type: 'state', state });
      if (requests.length === 1) throw Object.assign(new Error('排队响应丢失'), { status: 502 });
      return { ok: true, state };
    },
    '/queue/cancel': () => { state.queued = null; state.seq++; return { ok: true, state }; },
  }, async (page) => {
    await page.getByRole('heading', { name: state.title, exact: true }).waitFor();
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('重复文本的新意图');
    await page.getByRole('button', { name: '排队下一条', exact: true }).click();
    await page.getByText('排队响应丢失', { exact: true }).waitFor();
    await page.getByRole('button', { name: '取消排队', exact: true }).click();
    await page.getByRole('region', { name: '排队指令', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await input.inputValue(), '重复文本的新意图');
    await page.getByRole('button', { name: '排队下一条', exact: true }).click();
    await page.getByRole('region', { name: '排队指令', exact: true }).getByText('重复文本的新意图', { exact: true }).waitFor();
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].id, requests[1].id, '取消后的新意图不能复用已取消回执');
  });
});

test('排队响应失败后轮次推进或空闲，同一草稿重试仍确认原请求而不重复发送', async () => {
  for (const nextBusy of [true, false]) {
    const owner = { sessionId: 's1', turnId: 'owner-1' };
    const state = initialState({ title: '等待排队回执', busy: true, status: 'running', queueOwner: owner, queued: null, seq: 1 });
    const requests = []; let normalSends = 0;
    await withPage(state, {
      '/queue': (body) => {
        requests.push(body);
        if (requests.length === 1) throw Object.assign(new Error('回执暂时不可读'), { status: 502 });
        if (requests.length === 2) throw Object.assign(new Error('旧回执尚无法确认'), { status: 409 });
        return { ok: true, state }; // 同一请求已消费，返回回执而不新建队列
      },
      '/send': () => { normalSends++; return { ok: true }; },
    }, async (page, { emit }) => {
      await page.getByRole('heading', { name: state.title, exact: true }).waitFor();
      const input = page.getByRole('textbox', { name: '消息', exact: true });
      await input.fill('已消费请求的原文');
      await page.getByRole('button', { name: '排队下一条', exact: true }).click();
      await page.getByText('回执暂时不可读', { exact: true }).waitFor();
      state.busy = nextBusy; state.queueOwner = nextBusy ? { sessionId: 's1', turnId: 'owner-2' } : null;
      state.status = nextBusy ? 'running' : 'completed'; state.title = nextBusy ? '已进入下一轮' : '已回到空闲'; state.seq++;
      emit({ type: 'state', state });
      await page.getByRole('heading', { name: state.title, exact: true }).waitFor();
      await page.getByRole('button', { name: /^(排队下一条|发送|确认排队结果)$/ }).click();
      await page.getByText('旧回执尚无法确认', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), '已消费请求的原文', '未知结果的确认请求被拒绝时仍保留草稿');
      await page.getByRole('button', { name: '确认排队结果', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="消息"]').value === '');
      assert.equal(normalSends, 0, '已知请求结果不明时不得转换成新的 /send');
      assert.equal(requests.length, 3);
      assert.deepEqual(requests[1], requests[0], '确认使用原 id 和 owner，不转成新轮请求');
      assert.deepEqual(requests[2], requests[0], '确认请求的 409 不能解除去重保护');
    });
  }
});

test('排队回执未知或迟到后切换会话或工作区，同文输入作为新任务发送', async () => {
  for (const target of ['session', 'workspace']) {
    const owner = { sessionId: 's1', turnId: 'owner-1' };
    const state = initialState({ title: '旧任务正在执行', busy: true, status: 'running', queueOwner: owner, queued: null, seq: 1,
      projects: [
        { path: '/tmp/ui-project', name: 'ui-project', available: true, sessionCount: 1 },
        { path: '/tmp/next-project', name: 'next-project', available: true, sessionCount: 0 },
      ],
    });
    const queuedRequests = [], sent = [];
    await withPage(state, {
      '/queue': (body) => {
        queuedRequests.push(body);
        if (queuedRequests.length === 1) throw Object.assign(new Error('旧任务回执暂时不可读'), { status: 502 });
        return { ok: true, state };
      },
      '/session/new': () => { state.currentSessionId = 's2'; state.title = '新会话'; state.seq++; return { ok: true, state }; },
      '/workspace': ({ workspace }) => {
        assert.equal(workspace, '/tmp/next-project');
        state.config.workspace = workspace; state.title = '新项目任务'; state.seq++;
        return { ok: true, state };
      },
      '/send': ({ text }) => { sent.push({ text, sessionId: state.currentSessionId, workspace: state.config.workspace }); return { ok: true }; },
    }, async (page, { emit }) => {
      await page.getByRole('heading', { name: state.title, exact: true }).waitFor();
      const input = page.getByRole('textbox', { name: '消息', exact: true });
      await input.fill('继续');
      await page.getByRole('button', { name: '排队下一条', exact: true }).click();
      await page.getByText('旧任务回执暂时不可读', { exact: true }).waitFor();
      state.busy = false; state.status = 'completed'; state.queueOwner = null; state.title = '旧任务已完成'; state.seq++;
      emit({ type: 'state', state });
      await page.getByRole('heading', { name: state.title, exact: true }).waitFor();
      if (target === 'session') await page.getByRole('button', { name: '新任务', exact: true }).click();
      else await page.getByRole('button', { name: '打开项目 next-project', exact: true }).click();
      await page.getByRole('heading', { name: target === 'session' ? '新会话' : '新项目任务', exact: true }).waitFor();
      assert.equal(await input.inputValue(), '', '显式导航已结束旧输入上下文');
      await input.fill('继续');
      await page.getByRole('button', { name: /^(发送|确认排队结果)$/ }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="消息"]').value === '');
      assert.deepEqual(sent, [{ text: '继续', sessionId: target === 'session' ? 's2' : 's1', workspace: target === 'session' ? '/tmp/ui-project' : '/tmp/next-project' }]);
      assert.equal(queuedRequests.length, 1, '显式切换后的新任务不能确认旧上下文请求');
    });
  }
  for (const target of ['session', 'workspace']) {
    const state = initialState({ title: '旧任务正在执行', busy: true, status: 'running', queueOwner: { sessionId: 's1', turnId: 'owner-1' }, queued: null, seq: 1,
      projects: [
        { path: '/tmp/ui-project', name: 'ui-project', available: true, sessionCount: 1 },
        { path: '/tmp/next-project', name: 'next-project', available: true, sessionCount: 0 },
      ],
    });
    let release, acknowledge;
    const accepted = new Promise((resolve) => { acknowledge = resolve; });
    const sent = [];
    await withPage(state, {
      '/queue': async (body, { emit }) => {
        state.queued = { id: body.id, text: body.text, sessionId: body.sessionId }; state.seq++;
        emit({ type: 'state', state });
        const receiptState = structuredClone(state);
        await new Promise((resolve) => { release = resolve; acknowledge(); });
        return { ok: true, state: receiptState };
      },
      '/session/new': (_, { emit }) => {
        state.currentSessionId = 's2'; state.title = '新会话'; state.seq++;
        emit({ type: 'state', state }); return { ok: true, state };
      },
      '/workspace': ({ workspace }, { emit }) => {
        state.config.workspace = workspace; state.title = '新项目任务'; state.seq++;
        emit({ type: 'state', state }); return { ok: true, state };
      },
      '/send': ({ text }) => { sent.push({ text, sessionId: state.currentSessionId, workspace: state.config.workspace }); return { ok: true }; },
    }, async (page, { emit }) => {
      await page.getByRole('heading', { name: state.title, exact: true }).waitFor();
      const input = page.getByRole('textbox', { name: '消息', exact: true });
      await input.fill('继续');
      await page.getByRole('button', { name: '排队下一条', exact: true }).click();
      await accepted;
      state.busy = false; state.status = 'completed'; state.queueOwner = null; state.queued = null; state.title = '旧任务已完成'; state.seq++;
      emit({ type: 'state', state });
      const other = await page.context().browser().newPage();
      await other.goto(page.url());
      await other.getByRole('heading', { name: state.title, exact: true }).waitFor();
      if (target === 'session') await other.getByRole('button', { name: '新任务', exact: true }).click();
      else await other.getByRole('button', { name: '打开项目 next-project', exact: true }).click();
      const title = target === 'session' ? '新会话' : '新项目任务';
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      await input.fill('继续');
      const response = page.waitForResponse((result) => result.url().endsWith('/queue') && result.status() === 200);
      release(); await response;
      await page.waitForFunction(() => !document.getElementById('send').disabled || document.querySelector('[aria-label="消息"]').value === '');
      assert.equal(await input.inputValue(), '继续', '旧上下文 ACK 不能清空新上下文同文草稿');
      assert.equal(await page.getByRole('heading', { name: title, exact: true }).isVisible(), true, '旧 ACK 状态不能把新上下文回退');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="消息"]').value === '');
      assert.deepEqual(sent, [{ text: '继续', sessionId: target === 'session' ? 's2' : 's1', workspace: target === 'session' ? '/tmp/ui-project' : '/tmp/next-project' }]);
      await other.close();
    });
  }
});

test('新的排队请求被明确 409 拒绝后，空闲时同一草稿可正常发送', async () => {
  const state = initialState({ title: '当前轮即将完成', busy: true, status: 'running', queueOwner: { sessionId: 's1', turnId: 'owner-1' }, queued: null, seq: 1 });
  let queuedRequests = 0;
  const sent = [];
  await withPage(state, {
    '/queue': (body, { emit }) => {
      queuedRequests++;
      state.busy = false; state.status = 'completed'; state.queueOwner = null; state.title = '当前轮已完成'; state.seq++;
      emit({ type: 'state', state });
      throw Object.assign(new Error('当前轮已结束，未接受排队'), { status: 409 });
    },
    '/send': ({ text }) => { sent.push(text); return { ok: true }; },
  }, async (page) => {
    await page.getByRole('heading', { name: state.title, exact: true }).waitFor();
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('未接受的后续任务');
    await page.getByRole('button', { name: '排队下一条', exact: true }).click();
    await page.getByText('当前轮已结束，未接受排队', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '未接受的后续任务', '确定拒绝仍须保留原文');
    assert.equal(await page.getByRole('button', { name: /^(发送|确认排队结果)$/ }).textContent(), '发送', '确定未接受的输入可成为新的发送意图');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="消息"]').value === '');
    assert.deepEqual(sent, ['未接受的后续任务']);
    assert.equal(queuedRequests, 1, '不能继续确认根本未接受的旧排队请求');
  });
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

test('设置中心独立于工作区，八组可导航且模型保存后能返回工作区', async () => {
  const state = initialState();
  await withPage(state, { '/config': (body) => {
    state.config = { ...state.config, ...body }; delete state.config.apiKey; state.seq++;
    return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    const navigation = page.getByRole('navigation', { name: '设置分组', exact: true });
    for (const name of ['常规', '模型', '权限', '外观', '用量', '自动化', '技能', '命令']) {
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

test('日常工作台导航直达任务和扩展，输入区承载模型权限且长标题与窄屏布局可用', async () => {
  const title = '审查自动化产出、核对会话状态并继续本地开发改造的长任务标题'.repeat(12);
  await withPage(initialState({ title }), {
    '/automations': () => ({ automations: [] }),
    '/memory': () => ({ content: '' }),
  }, async (page) => {
    const composer = page.locator('footer.composer');
    assert.equal(await composer.getByRole('combobox', { name: '切换模型配置', exact: true }).isVisible(), true);
    assert.equal(await composer.getByRole('checkbox', { name: '全部免审批', exact: true }).isVisible(), true);
    assert.equal(await page.locator('header').getByRole('combobox', { name: '切换模型配置', exact: true }).count(), 0);
    const heading = page.getByRole('heading', { name: title, exact: true });
    const titleBounds = await heading.boundingBox();
    const statusBounds = await page.locator('#status').boundingBox();
    const changesBounds = await page.getByRole('button', { name: '查看变更', exact: true }).boundingBox();
    assert.ok(titleBounds && statusBounds && changesBounds);
    assert.ok(titleBounds.height <= changesBounds.height, '长标题应保持单行');
    assert.ok(titleBounds.x + titleBounds.width <= statusBounds.x, '长标题不能覆盖任务状态');
    assert.ok(statusBounds.x + statusBounds.width <= changesBounds.x, '任务状态不能覆盖变更入口');
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('尚未发送的任务草稿');
    await page.getByRole('button', { name: '自动化任务', exact: true }).click();
    await page.getByRole('heading', { name: '自动化', exact: true }).waitFor();
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    assert.equal(await input.inputValue(), '尚未发送的任务草稿');
    await page.getByRole('button', { name: '技能与扩展', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '添加服务器', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.getByRole('button', { name: '查看变更', exact: true }).click();
    await page.getByRole('heading', { name: 'Git 变更', exact: true }).waitFor();
    const sendHit = await composer.getByRole('button', { name: '发送', exact: true }).evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return { reachable: button.contains(hit), hitElement: hit?.id || hit?.tagName || 'none' };
    });
    assert.equal(sendHit.reachable, true, `1100px 桌面窗口打开变更时发送按钮不应被遮挡；实际命中 ${sendHit.hitElement}`);
    const desktopTitleBounds = await heading.boundingBox();
    const desktopStatusBounds = await page.locator('#status').boundingBox();
    const desktopChangesBounds = await page.getByRole('button', { name: '收起变更', exact: true }).boundingBox();
    assert.ok(desktopTitleBounds && desktopStatusBounds && desktopChangesBounds);
    assert.ok(desktopTitleBounds.x + desktopTitleBounds.width <= desktopStatusBounds.x, '1100px 桌面窗口的长标题不能覆盖任务状态');
    assert.ok(desktopStatusBounds.x + desktopStatusBounds.width <= desktopChangesBounds.x, '1100px 桌面窗口的任务状态不能覆盖变更入口');
    await page.getByRole('button', { name: '关闭变更', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await heading.isVisible(), true);
    assert.equal(await input.isVisible(), true);
    assert.equal(await composer.getByRole('combobox', { name: '切换模型配置', exact: true }).isVisible(), true);
    assert.equal(await composer.getByRole('checkbox', { name: '全部免审批', exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '窄屏不应横向溢出');
  });
});

test('首次启动空态可选择项目和配置模型，未就绪时不能创建自动化任务', async () => {
  const state = initialState({ ready: false, projects: [], config: {
    ...initialState().config, workspace: '', baseUrl: '', model: '', hasApiKey: false,
  } });
  const created = [];
  await withPage(state, { '/automations': (body) => {
    if (body.name) created.push(body);
    return { automations: [] };
  } }, async (page) => {
    await page.locator('#settings-home:enabled').waitFor({ state: 'attached' });
    const back = page.getByRole('button', { name: '返回工作区', exact: true });
    if (await back.isVisible()) await back.click();
    assert.equal(await page.getByRole('button', { name: '选择项目', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '配置模型', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: '模型', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    await page.getByRole('button', { name: '自动化任务', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '运行任务', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('textbox', { name: '任务名称', exact: true }).isDisabled(), true);
    assert.match(await page.getByRole('alert').filter({ visible: true }).last().textContent(), /项目|模型/);
    assert.deepEqual(created, []);
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

test('中文输入法选词 Enter 不发送或清空草稿，组合结束后 Enter 可发送', async () => {
  const sent = [];
  await withPage(initialState(), { '/send': (body) => { sent.push(body); return { ok: true }; } }, async (page) => {
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('测试中文选词');
    const compositionRequest = page.waitForRequest((request) => request.url().endsWith('/send'), { timeout: 300 });
    await input.evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', isComposing: true, bubbles: true, cancelable: true,
    })));
    await assert.rejects(compositionRequest, /Timeout/, '输入法选词期间不能发送请求');
    assert.equal(await input.inputValue(), '测试中文选词');
    assert.deepEqual(sent, []);
    await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('[aria-label="消息"]').value === '');
    assert.deepEqual(sent, [{ text: '测试中文选词' }]);
  });
});

test('常规与外观偏好保存后刷新保留，并改变主题字号和消息发送按键', async () => {
  const state = initialState(); let received;
  await withPage(state, {
    '/preferences': (body) => { state.preferences = body; state.seq++; return { ok: true, state }; },
    '/send': ({ text }) => { received = text; return { ok: true }; },
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click({ timeout: 2000 });
    const darkColor = await page.locator('body').evaluate((body) => getComputedStyle(body).color);
    await page.getByLabel('Enter 发送消息', { exact: true }).uncheck();
    await page.getByRole('button', { name: '保存常规设置', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '外观', exact: true }).click();
    await page.getByLabel('主题', { exact: true }).selectOption('light');
    await page.getByLabel('消息字号', { exact: true }).selectOption('18');
    await page.getByRole('button', { name: '保存外观设置', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    await page.reload();
    assert.notEqual(await page.locator('body').evaluate((body) => getComputedStyle(body).color), darkColor, '浅色主题刷新后仍应改变可见文字颜色');
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
    assert.deepEqual(saved, { approval: 'never', allowWriteDirs: ['/tmp/extra-project'], afterTurn: '', beforeTurn: '' });
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '权限', exact: true }).click();
    assert.equal(await page.getByLabel('默认审批方式', { exact: true }).inputValue(), 'never');
    assert.equal(await page.getByText('/tmp/extra-project', { exact: true }).isVisible(), true);
  }, { initScript: () => { window.__TAURI__ = { core: { invoke: async () => '/tmp/extra-project' } }; } });
});

test('权限和偏好草稿跨设置分组与状态同步保留，保存及刷新可回读', async () => {
  const state = initialState();
  state.config.beforeTurn = 'echo saved-before'; state.config.afterTurn = 'echo saved-after';
  const saved = {};
  await withPage(state, {
    '/config': (body) => { saved.permissions = body; state.config = { ...state.config, ...body }; state.seq++; return { ok: true, state }; },
    '/preferences': (body) => { saved.preferences = body; state.preferences = body; state.seq++; return { ok: true, state }; },
  }, async (page, { emit }) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const nav = page.getByRole('navigation', { name: '设置分组', exact: true });
    await nav.getByRole('button', { name: '权限', exact: true }).click();
    const before = page.getByLabel('轮开始钩子（留空禁用）', { exact: true });
    const after = page.getByLabel('轮结束钩子（留空禁用）', { exact: true });
    assert.equal(await before.inputValue(), 'echo saved-before');
    assert.equal(await after.inputValue(), 'echo saved-after');
    await before.fill('echo draft-before'); await after.fill('echo draft-after');
    await page.getByLabel('默认审批方式', { exact: true }).selectOption('never');
    await page.getByRole('button', { name: '添加免审批目录', exact: true }).click();
    await page.getByText('/tmp/extra-project', { exact: true }).waitFor();
    await nav.getByRole('button', { name: '外观', exact: true }).click();
    await page.getByLabel('主题', { exact: true }).selectOption('light');
    await page.getByLabel('消息字号', { exact: true }).selectOption('18');
    await nav.getByRole('button', { name: '常规', exact: true }).click();
    await page.getByLabel('Enter 发送消息', { exact: true }).uncheck();
    state.seq++; emit({ type: 'state', state });
    await nav.getByRole('button', { name: '权限', exact: true }).click();
    assert.equal(await before.inputValue(), 'echo draft-before');
    assert.equal(await after.inputValue(), 'echo draft-after');
    assert.equal(await page.getByLabel('默认审批方式', { exact: true }).inputValue(), 'never');
    assert.equal(await page.getByText('/tmp/extra-project', { exact: true }).isVisible(), true);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/config') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存权限设置', exact: true }).click(),
    ]);
    assert.deepEqual(saved.permissions, { approval: 'never', allowWriteDirs: ['/tmp/extra-project'], beforeTurn: 'echo draft-before', afterTurn: 'echo draft-after' });
    await nav.getByRole('button', { name: '常规', exact: true }).click();
    assert.equal(await page.getByLabel('Enter 发送消息', { exact: true }).isChecked(), false);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/preferences') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存常规设置', exact: true }).click(),
    ]);
    await nav.getByRole('button', { name: '外观', exact: true }).click();
    assert.equal(await page.getByLabel('主题', { exact: true }).inputValue(), 'light');
    assert.equal(await page.getByLabel('消息字号', { exact: true }).inputValue(), '18');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/preferences') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存外观设置', exact: true }).click(),
    ]);
    assert.deepEqual(saved.preferences, { theme: 'light', fontSize: 18, enterToSend: false });
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await nav.getByRole('button', { name: '权限', exact: true }).click();
    assert.equal(await before.inputValue(), 'echo draft-before');
    assert.equal(await after.inputValue(), 'echo draft-after');
    await nav.getByRole('button', { name: '外观', exact: true }).click();
    assert.equal(await page.getByLabel('主题', { exact: true }).inputValue(), 'light');
    assert.equal(await page.getByLabel('消息字号', { exact: true }).inputValue(), '18');
    await nav.getByRole('button', { name: '常规', exact: true }).click();
    assert.equal(await page.getByLabel('Enter 发送消息', { exact: true }).isChecked(), false);
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
    saved = body; state.ready = true; state.config = { ...state.config, ...body, hasApiKey: true }; delete state.config.apiKey; delete state.configError;
    return { ok: true, state };
  } }, async (page) => {
    await page.getByRole('button', { name: '配置模型', exact: true }).click();
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

test('自动化隔离执行勾选提交 worktree，创建成功后恢复默认不隔离', async () => {
  const created = [];
  await withPage(initialState(), { '/automations': (body) => {
    if (body.name) created.push(body);
    return { ok: true, automations: [] };
  } }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分组', exact: true }).getByRole('button', { name: '自动化', exact: true }).click();
    const isolation = page.getByRole('checkbox', { name: '在独立 worktree 中执行', exact: true });
    assert.equal(await isolation.isChecked(), false);
    await page.getByLabel('任务名称', { exact: true }).fill('隔离检查');
    await page.getByLabel('任务提示词', { exact: true }).fill('检查并写报告');
    await isolation.check();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/automations') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '运行任务', exact: true }).click(),
    ]);
    await page.waitForFunction(() => document.getElementById('automation-name').value === '');
    assert.deepEqual(created, [{ name: '隔离检查', prompt: '检查并写报告', workspace: '/tmp/ui-project', worktree: true }]);
    assert.equal(await isolation.isChecked(), false);
    await page.getByLabel('任务名称', { exact: true }).fill('默认检查');
    await page.getByLabel('任务提示词', { exact: true }).fill('只读检查');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/automations') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '运行任务', exact: true }).click(),
    ]);
    assert.equal(created.length, 2);
    assert.equal(created[1].worktree === true, false);
  });
});

test('自动化设置可创建任务、查看状态与结果、停止与继续、删除', async () => {
  const state = initialState();
  let stopped = false, paused = true, removed = false;
  await withPage(state, {
    '/automations': () => ({ automations: removed ? [] : [{
      id: 'a1', name: '夜间检查', workspace: '/tmp/ui-project', prompt: '做点什么',
      status: stopped ? 'stopped' : 'running', createdAt: 1,
      intervalMinutes: 30, paused, nextRunAt: Date.now() + 30 * 60_000,
    }] }),
    '/automations/stop': () => { stopped = true; return { ok: true }; },
    '/automations/resume': () => { stopped = false; return { ok: true }; },
    '/automations/schedule': (body) => { paused = body.paused; return { ok: true }; },
    '/automations/delete': () => { removed = true; state.seq++; return { ok: true }; },
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: '设置分组', exact: true });
    await navigation.getByRole('button', { name: '自动化', exact: true }).click();
    await page.getByText('夜间检查', { exact: true }).waitFor();
    await page.getByText('运行中', { exact: true }).waitFor();
    await page.getByText(/每 30 分钟/, { exact: false }).waitFor();
    await page.getByText('调度已暂停', { exact: true }).waitFor();
    await page.getByRole('button', { name: '恢复调度', exact: true }).click();
    await page.getByRole('button', { name: '暂停调度', exact: true }).waitFor();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await page.getByText('已停止', { exact: true }).waitFor();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByText('运行中', { exact: true }).waitFor();
    await page.getByLabel('任务名称', { exact: true }).fill('新任务');
    await page.getByLabel('任务提示词', { exact: true }).fill('把报告写入 report.md');
    await page.getByRole('button', { name: '运行任务', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('automation-name').value === '', undefined, { timeout: 3000 });
    await page.getByText('夜间检查', { exact: true }).waitFor();
  });
});

test('自动化设置可删除已停止的任务（清理任务与会话记录）', async () => {
  const state = initialState();
  let removed = false;
  await withPage(state, {
    '/automations': () => ({ automations: removed ? [] : [{ id: 'a1', name: '夜间检查', workspace: '/tmp/ui-project', prompt: '做点什么', status: 'stopped', createdAt: 1 }] }),
    '/automations/delete': () => { removed = true; return { ok: true }; },
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: '设置分组', exact: true });
    await navigation.getByRole('button', { name: '自动化', exact: true }).click();
    await page.getByText('夜间检查', { exact: true }).waitFor();
    await page.getByRole('button', { name: '删除任务 夜间检查', exact: true }).click();
    await page.getByText('尚无任务；填写上方表单即可在当前项目后台运行一条自动化任务', { exact: true }).waitFor();
  });
});

test('命令页可管理 MCP 服务器：添加、测试连接与启停', async () => {
  const state = initialState();
  let servers = [];
  let tested = 0;
  await withPage(state, {
    '/mcp/servers': (body) => {
      const server = { id: body.id || 'srv-1', name: body.name, command: body.command, args: body.args, enabled: body.enabled, trusted: body.trusted, trustedTools: body.trustedTools };
      if (body.id) servers = servers.map((entry) => (entry.id === body.id ? { ...entry, ...server } : entry));
      else servers.push(server);
      state.capabilities.mcpServers = servers; state.seq++;
      return { ok: true, state };
    },
    '/mcp/servers/enabled': (body) => {
      servers = servers.map((entry) => (entry.id === body.id ? { ...entry, enabled: body.enabled } : entry));
      state.capabilities.mcpServers = servers; state.seq++;
      return { ok: true, state };
    },
    '/mcp/servers/delete': (body) => {
      servers = servers.filter((entry) => entry.id !== body.id);
      state.capabilities.mcpServers = servers; state.seq++;
      return { ok: true, state };
    },
    '/mcp/test': () => { tested++; return { tools: tested === 1 ? ['echo'] : [] }; },
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: '设置分组', exact: true });
    await navigation.getByRole('button', { name: '命令', exact: true }).click();
    await page.getByRole('button', { name: '添加服务器', exact: true }).click();
    await page.getByLabel('名称（字母、数字、下划线、连字符）', { exact: true }).fill('demo');
    await page.getByLabel('启动命令', { exact: true }).fill('node');
    await page.getByLabel(/启动参数/, { exact: false }).fill('["server.mjs"]');
    await page.getByRole('checkbox', { name: '免审批（信任此服务器，其工具不再逐次确认）', exact: true }).check();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal(servers[0].trusted, true, '信任标记须提交到后端');
    await page.getByRole('button', { name: '添加服务器', exact: true }).click();
    await page.getByLabel('名称（字母、数字、下划线、连字符）', { exact: true }).fill('partial');
    await page.getByLabel('启动命令', { exact: true }).fill('node');
    await page.getByLabel('免审批工具（逗号分隔的工具名；勾选免审批时忽略）', { exact: true }).fill('echo, search');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    assert.deepEqual(servers.find((entry) => entry.name === 'partial')?.trustedTools, ['echo', 'search'], '按工具白名单须提交到后端');
    await page.getByText('免审批', { exact: true }).waitFor();
    await page.getByRole('button', { name: '测试 MCP 服务器 demo', exact: true }).click();
    await page.getByText('连接成功，工具：echo', { exact: true }).waitFor();
    await page.getByRole('button', { name: '停用 demo', exact: true }).click();
    await page.getByRole('button', { name: '启用 demo', exact: true }).waitFor();
  });
});

test('HTTP MCP 编辑可回显并保存传输端点，切换 stdio 后不残留 HTTP 地址', async () => {
  const server = { id: 'http-1', name: 'remote', command: '', url: 'http://127.0.0.1:9123/mcp', enabled: false };
  const state = initialState({ capabilities: { commands: [], skills: [], tools: [], mcpServers: [server] } });
  const saved = [];
  await withPage(state, {
    '/memory': () => ({ content: '' }),
    '/mcp/servers': (body) => {
      saved.push(body);
      state.capabilities.mcpServers = [{ ...server, ...body }]; state.seq++;
      return { ok: true, state };
    },
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const nav = page.getByRole('navigation', { name: '设置分组', exact: true });
    await nav.getByRole('button', { name: '命令', exact: true }).click();
    await page.getByRole('button', { name: '编辑 MCP 服务器 remote', exact: true }).click();
    const transport = page.getByLabel('传输方式', { exact: true });
    const endpoint = page.getByLabel('MCP 端点', { exact: true });
    assert.equal(await transport.inputValue(), 'http');
    assert.equal(await endpoint.inputValue(), 'http://127.0.0.1:9123/mcp');
    await endpoint.fill('http://127.0.0.1:9456/mcp');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/mcp/servers') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存', exact: true }).click(),
    ]);
    assert.equal(saved[0].id, 'http-1');
    assert.equal(saved[0].url, 'http://127.0.0.1:9456/mcp');
    assert.equal(saved[0].command || '', '');
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await nav.getByRole('button', { name: '命令', exact: true }).click();
    await page.getByRole('button', { name: '编辑 MCP 服务器 remote', exact: true }).click();
    assert.equal(await transport.inputValue(), 'http');
    assert.equal(await endpoint.inputValue(), 'http://127.0.0.1:9456/mcp');
    await transport.selectOption('stdio');
    await page.getByLabel('启动命令', { exact: true }).fill('node');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/mcp/servers') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存', exact: true }).click(),
    ]);
    assert.equal(saved.length, 2);
    assert.equal(saved[1].command, 'node');
    assert.equal(saved[1].url || '', '');
  });
});

test('自动化任务结束时工作区顶部出现通知', async () => {
  const state = initialState();
  await withPage(state, {}, async (page, { streams }) => {
    for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: 'automation', name: '夜间检查', status: 'completed', seq: 99 })}\n\n`);
    await page.getByText('自动化任务「夜间检查」已完成', { exact: true }).waitFor();
  });
});

test('命令页可编辑与清空长期记忆', async () => {
  const state = initialState();
  let memory = '- 旧记忆一条\n';
  let cleared = false;
  await withPage(state, {
    '/memory': () => (cleared ? { content: '' } : { content: memory }),
    '/memory/clear': () => { cleared = true; memory = ''; return { ok: true }; },
  }, async (page) => {
    await page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: '设置分组', exact: true });
    await navigation.getByRole('button', { name: '命令', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '长期记忆（memory.md）', exact: true });
    await editor.waitFor();
    await page.waitForFunction(() => document.getElementById('memory-editor').value !== '', undefined, { timeout: 3000 });
    await editor.fill('- 新记忆：用户偏好 pnpm');
    await page.getByRole('button', { name: '保存记忆', exact: true }).click();
    await page.getByText('长期记忆已保存并注入后续对话', { exact: true }).waitFor();
    await page.getByRole('button', { name: '清空', exact: true }).click();
    await page.getByText('长期记忆已清空', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), '');
  });
});

test('自动化任务运行期间主会话发送提示互斥', async () => {
  const state = initialState();
  await withPage(state, {
    '/automations': () => ({ automations: [{ id: 'a1', name: '后台任务', workspace: '/tmp/ui-project', prompt: '做点什么', status: 'running', createdAt: 1 }] }),
    '/send': () => ({ error: '自动化任务正在运行（与主会话共用工作目录基准），请等待完成或先停止任务' }),
  }, async (page) => {
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('主会话任务');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('自动化任务正在运行（与主会话共用工作目录基准），请等待完成或先停止任务', { exact: true }).waitFor();
  });
});

test('HTTP MCP 目录条目缺省启动参数仍可预填端点并保存', async () => {
  const state = initialState(); let saved;
  await withPage(state, {
    '/memory': () => ({ content: '' }),
    '/mcp/catalog': () => ({ catalog: [{ name: 'remote', url: 'http://127.0.0.1:9456/mcp', description: 'HTTP 服务' }] }),
    '/mcp/servers': (body) => {
      saved = body; state.capabilities.mcpServers = [{ id: 'http-1', ...body }]; state.seq++;
      return { ok: true, state };
    },
  }, async (page) => {
    await page.getByRole('button', { name: '技能与扩展', exact: true }).click();
    await page.getByRole('button', { name: '从目录添加', exact: true }).click();
    await page.getByRole('button', { name: '使用 remote', exact: true }).click();
    assert.equal(await page.getByLabel('传输方式', { exact: true }).inputValue(), 'http');
    assert.equal(await page.getByLabel('MCP 端点', { exact: true }).inputValue(), 'http://127.0.0.1:9456/mcp');
    assert.equal(await page.getByLabel('启动命令', { exact: true }).isVisible(), false);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/mcp/servers') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存', exact: true }).click(),
    ]);
    assert.equal(saved.name, 'remote');
    assert.equal(saved.url, 'http://127.0.0.1:9456/mcp');
    assert.equal(saved.command || '', '');
    assert.equal(Object.hasOwn(saved, 'args'), false);
  });
});

test('命令页可从内置目录预填 MCP 服务器表单', async () => {
  const state = initialState();
  const saved = [];
  await withPage(state, {
    '/mcp/catalog': () => ({ catalog: [
      { name: 'filesystem', description: '文件系统访问（官方参考实现）', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<目录路径>'] },
    ] }),
    '/mcp/servers': (body) => { saved.push(body); state.capabilities.mcpServers = [{ id: 'srv-1', ...body }]; state.seq++; return { ok: true, state }; },
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: '设置分组', exact: true });
    await navigation.getByRole('button', { name: '命令', exact: true }).click();
    await page.getByRole('button', { name: '从目录添加', exact: true }).click();
    await page.getByText('文件系统访问（官方参考实现）', { exact: true }).waitFor();
    await page.getByRole('button', { name: '使用 filesystem', exact: true }).click();
    assert.equal(await page.getByLabel('名称（字母、数字、下划线、连字符）', { exact: true }).inputValue(), 'filesystem');
    assert.equal(await page.getByLabel('启动命令', { exact: true }).inputValue(), 'npx');
    assert.equal(await page.getByLabel(/启动参数/, { exact: false }).inputValue(), JSON.stringify(['-y', '@modelcontextprotocol/server-filesystem', '<目录路径>']));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('demo（免审批）', { exact: true }).waitFor().catch(() => {});
    await page.waitForFunction(() => document.getElementById('mcp-list').textContent.includes('filesystem'), undefined, { timeout: 3000 });
    assert.deepEqual(JSON.parse(JSON.stringify(saved[0])), { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<目录路径>'], enabled: true, trusted: false });
  });
});

test('自动化列表展示 worktree 路径与分支合并引导', async () => {
  const state = initialState();
  await withPage(state, {
    '/automations': () => ({ automations: [{
      id: 'a1b2c3d4', name: 'worktree 任务', workspace: '/tmp/ui-project', prompt: '做点什么',
      status: 'completed', createdAt: 1, worktree: true,
      worktreePath: '/repo/.tcode-worktrees/a1b2c3d4', branch: 'tcode-a1b2c3d4',
    }] }),
  }, async (page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: '设置分组', exact: true });
    await navigation.getByRole('button', { name: '自动化', exact: true }).click();
    await page.getByText('worktree：/repo/.tcode-worktrees/a1b2c3d4', { exact: true }).waitFor();
    await page.getByText(/git merge tcode-a1b2c3d4/, { exact: false }).waitFor();
  });
});

test('worktree 清理失败后刷新部分完成状态，保留错误并可重试剩余分支', async () => {
  const state = initialState(), calls = [];
  const task = {
    id: 'a1b2c3d4', name: 'worktree 任务', workspace: '/tmp/ui-project', prompt: '做点什么',
    status: 'stopped', createdAt: 1, intervalMinutes: 30, paused: true,
    worktreePath: '/repo/.tcode-worktrees/a1b2c3d4', branch: 'tcode-a1b2c3d4', worktreeCleanupPending: true,
  };
  let listed = 0;
  await withPage(state, {
    '/automations': () => { listed++; return { automations: [task] }; },
    '/automations/worktree/remove': (body) => {
      calls.push(body);
      if (calls.length === 1) {
        delete task.worktreePath; task.worktreeCleanupPending = true;
        throw new Error('worktree 已移除，但分支删除失败，请重试');
      }
      delete task.worktreeCleanupPending; delete task.branch;
      return { ok: true };
    },
  }, async (page, { emit }) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分组', exact: true }).getByRole('button', { name: '自动化', exact: true }).click();
    const remove = page.getByRole('button', { name: '删除任务 worktree 任务', exact: true });
    await remove.waitFor();
    assert.equal(await remove.isDisabled(), true);
    await page.getByText('先清理 worktree 和分支，再删除任务记录', { exact: true }).waitFor();
    await page.getByText('worktree：/repo/.tcode-worktrees/a1b2c3d4', { exact: true }).waitFor();
    assert.equal(await page.getByText('worktree 已移除，分支待清理：tcode-a1b2c3d4', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '重试清理 worktree 任务', exact: true }).click();
    await page.getByText('worktree 已移除，分支待清理：tcode-a1b2c3d4', { exact: true }).waitFor();
    await page.getByText('worktree 已移除，但分支删除失败，请重试', { exact: true }).waitFor();
    assert.equal(await page.getByText('worktree：/repo/.tcode-worktrees/a1b2c3d4', { exact: true }).count(), 0);
    assert.ok(listed >= 2, '失败后必须重新读取任务资源状态');
    state.busy = true; state.seq++; emit({ type: 'state', state });
    await page.getByRole('button', { name: '运行任务', exact: true }).and(page.locator(':disabled')).waitFor();
    state.busy = false; state.seq++; emit({ type: 'state', state });
    await page.getByRole('button', { name: '运行任务', exact: true }).and(page.locator(':enabled')).waitFor();
    assert.equal(await page.getByRole('button', { name: '继续', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '恢复调度', exact: true }).isDisabled(), true);
    assert.equal(await remove.isDisabled(), true, '状态同步不应解除剩余分支的删除保护');
    await page.getByRole('button', { name: '重试清理 worktree 任务', exact: true }).click();
    await remove.and(page.locator(':enabled')).waitFor();
    assert.deepEqual(calls, [{ id: task.id, mode: 'merged' }, { id: task.id, mode: 'merged' }]);
    assert.equal(await page.locator('#automation-error').textContent(), '');
    assert.equal(await page.getByRole('button', { name: '继续', exact: true }).isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: '恢复调度', exact: true }).isDisabled(), false);
  });
});

test('丢弃 worktree 须显式确认，运行中和导航锁定时不得清理', async () => {
  const state = initialState(), calls = [];
  const completed = { id: 'done-id', name: '已结束任务', status: 'completed', createdAt: 1, worktreePath: '/repo/wt/done', branch: 'tcode-done-id' };
  const running = { id: 'running-id', name: '运行任务', status: 'running', createdAt: 1, worktreePath: '/repo/wt/running', branch: 'tcode-running-' };
  await withPage(state, {
    '/automations': () => ({ automations: [completed, running] }),
    '/automations/worktree/remove': (body) => { calls.push(body); delete completed.worktreePath; return { ok: true }; },
  }, async (page, { emit }) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分组', exact: true }).getByRole('button', { name: '自动化', exact: true }).click();
    const discard = page.getByRole('button', { name: '丢弃 worktree 已结束任务', exact: true });
    await discard.waitFor();
    assert.equal(await page.getByRole('button', { name: '清理 worktree 运行任务', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '丢弃 worktree 运行任务', exact: true }).isDisabled(), true);
    state.busy = true; state.seq++; emit({ type: 'state', state });
    await discard.and(page.locator(':disabled')).waitFor();
    state.busy = false; state.seq++; emit({ type: 'state', state });
    await discard.and(page.locator(':enabled')).waitFor();
    assert.equal(await page.getByRole('button', { name: '清理 worktree 运行任务', exact: true }).isDisabled(), true, 'SSE 解锁不应解除运行中清理保护');
    const cancelled = page.waitForEvent('dialog');
    const cancelledClick = discard.click();
    const first = await cancelled;
    assert.match(first.message(), /未合并的修改会被删除/);
    await first.dismiss(); await cancelledClick;
    assert.deepEqual(calls, []);
    const confirmed = page.waitForEvent('dialog');
    const confirmedClick = discard.click();
    await (await confirmed).accept(); await confirmedClick;
    await page.getByRole('button', { name: '删除任务 已结束任务', exact: true }).and(page.locator(':enabled')).waitFor();
    assert.deepEqual(calls, [{ id: 'done-id', mode: 'discard' }]);
    assert.equal(await page.getByRole('button', { name: '已完成', exact: true }).isDisabled(), true);
  });
});

test('项目树把当前项目会话挂在项目行下，显示相对时间，超过 5 条折叠为「展开其余 N 个」', async () => {
  const now = Date.now();
  const sessions = Array.from({ length: 7 }, (_, i) => ({ id: 's' + (i + 1), title: '会话 ' + (i + 1), cwd: '/tmp/ui-project', mtime: now - (i + 1) * 3 * 3600e3 }));
  sessions[1].mtime = now - 12 * 60e3;
  const projects = [initialState().projects[0], { path: '/tmp/another-project', name: 'another-project', available: true, sessionCount: 2 }];
  await withPage(initialState({ sessions, projects }), {}, async (page) => {
    const tree = page.getByRole('navigation', { name: '项目列表', exact: true });
    await tree.getByRole('button', { name: '打开会话 会话 1', exact: true }).waitFor();
    const order = await tree.locator('button[aria-label^="打开"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    assert.deepEqual(order, ['打开项目 ui-project', '打开会话 会话 1', '打开会话 会话 2', '打开会话 会话 3', '打开会话 会话 4', '打开会话 会话 5', '打开项目 another-project']);
    assert.equal(await tree.getByText('12 分钟', { exact: true }).isVisible(), true);
    await tree.getByRole('button', { name: '展开其余 2 个', exact: true }).click();
    assert.equal(await tree.getByRole('button', { name: '打开会话 会话 7', exact: true }).isVisible(), true);
    assert.equal(await tree.getByRole('button', { name: /^展开其余/ }).count(), 0);
  });
});

test('Cmd/Ctrl+K 展开分区头搜索，Esc 清空关键词并收起', async () => {
  const sessions = [{ id: 's1', title: '排查加载问题', cwd: '/tmp/ui-project', mtime: 2 }, { id: 's2', title: '优化列表', cwd: '/tmp/ui-project', mtime: 1 }];
  await withPage(initialState({ sessions }), {}, async (page) => {
    const search = page.getByRole('textbox', { name: '搜索会话', exact: true });
    await page.getByRole('button', { name: '打开会话 优化列表', exact: true }).waitFor();
    await page.keyboard.press('Control+k');
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
    await search.pressSequentially('优化');
    assert.equal(await page.getByRole('button', { name: '打开会话 排查加载问题', exact: true }).count(), 0);
    await search.press('Escape');
    assert.equal(await search.inputValue(), '');
    assert.equal(await search.evaluate((element) => document.activeElement === element), false);
    assert.equal(await page.getByRole('button', { name: '打开会话 排查加载问题', exact: true }).isVisible(), true);
  });
});

test('底部账户行向上弹出菜单，Esc 关闭，菜单中的设置与齿轮打开同一设置中心', async () => {
  await withPage(initialState(), {}, async (page) => {
    const account = page.getByRole('button', { name: '账户菜单', exact: true });
    await account.click({ timeout: 2000 });
    const menu = page.getByRole('menu', { name: '账户菜单', exact: true });
    await menu.waitFor();
    for (const name of ['设置', '打开配置文件', '关于 tcode']) assert.equal(await menu.getByRole('menuitem', { name, exact: true }).isVisible(), true);
    const [menuBox, accountBox] = [await menu.boundingBox(), await account.boundingBox()];
    assert.ok(menuBox.y + menuBox.height <= accountBox.y, '菜单应向上弹出');
    assert.equal(await account.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await account.getAttribute('aria-expanded'), 'false');
    await account.click();
    await menu.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('region', { name: '设置中心', exact: true }).waitFor();
    assert.equal(await menu.isVisible(), false);
  });
});

test('缺少模型时 hero 不放操作按钮，只在 composer 上方显示一条 notice，顶栏只留面板图标', async () => {
  const state = initialState({ ready: false, configError: '请先配置模型', config: { ...initialState().config, baseUrl: '', model: '', hasApiKey: false } });
  await withPage(state, {}, async (page) => {
    await page.getByRole('heading', { name: '今天要改哪段代码？', exact: true }).waitFor();
    assert.equal(await page.locator('#log').getByRole('button').count(), 0, 'hero 不再放操作按钮');
    const notices = page.getByRole('alert').filter({ visible: true });
    assert.equal(await notices.count(), 1);
    const notice = notices.first();
    assert.equal(await notice.getByRole('button', { name: '配置模型', exact: true }).isVisible(), true);
    const [noticeBox, inputBox] = [await notice.boundingBox(), await page.locator('.input-box').boundingBox()];
    assert.ok(noticeBox.y + noticeBox.height <= inputBox.y, 'notice 位于 composer 上方');
    assert.equal(await page.locator('#status').isVisible(), false, '顶栏不再显示「未配置」状态胶囊');
    const changes = page.getByRole('button', { name: '查看变更', exact: true });
    assert.equal((await changes.innerText()).trim(), '', '变更入口只是面板图标');
    assert.equal(await page.locator('#composer-foot').isVisible(), false, '没有可用模型时隐藏说明行');
  });
});

test('空会话的项目 chip 与模式 chip 位于输入框上方，composer 底行依次为 + / 权限 / 模型 / 发送', async () => {
  const commands = [];
  const state = initialState();
  await withPage(state, { '/command': (body) => { commands.push(body.line); state.planMode = !state.planMode; return { state }; } }, async (page) => {
    const composer = page.locator('footer.composer');
    const project = composer.getByRole('button', { name: 'ui-project', exact: true });
    const mode = composer.getByRole('button', { name: '标准模式', exact: true });
    const inputBox = await page.locator('.input-box').boundingBox();
    for (const chip of [project, mode]) {
      const box = await chip.boundingBox();
      assert.ok(box.y + box.height <= inputBox.y, 'chip 位于输入框上方');
    }
    await project.click();
    const projectMenu = page.getByRole('menu', { name: '选择项目', exact: true });
    assert.equal(await projectMenu.getByRole('menuitem', { name: '打开其他目录…', exact: true }).isVisible(), true);
    await page.keyboard.press('Escape');
    await projectMenu.waitFor({ state: 'hidden' });
    await mode.click();
    await page.getByRole('menu', { name: '模式', exact: true }).getByRole('menuitemradio', { name: '计划模式', exact: true }).click();
    await composer.getByRole('button', { name: '计划模式', exact: true }).waitFor();
    assert.deepEqual(commands, ['/plan']);
    const row = page.locator('.composer-toolbar');
    const xs = [];
    for (const control of [row.getByRole('button', { name: '插入命令', exact: true }), row.getByRole('checkbox', { name: '全部免审批', exact: true }), row.getByRole('combobox', { name: '切换模型配置', exact: true }), row.getByRole('button', { name: '发送', exact: true })]) {
      xs.push((await control.boundingBox()).x);
    }
    assert.deepEqual([...xs].sort((a, b) => a - b), xs, '底行顺序为 + / 权限 / 模型 / 发送');
    assert.ok(xs[2] > inputBox.x + inputBox.width / 2, '模型选择靠右');
    await row.getByRole('button', { name: '插入命令', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '/');
  });
});
