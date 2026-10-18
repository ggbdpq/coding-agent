// 自动化任务：一条本地任务的可停止、可恢复、可查看结果闭环。
// 已确认边界：真实 CLI/HTTP、隔离会话以免审批运行（无人值守语义）、外部假模型端点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('等待自动化任务状态超时');
}

async function fixture(t, { mode = 'ok', configured = true, hangRequests = [1] } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tcode-auto-')));
  const data = path.join(root, 'data'), workspace = path.join(root, 'project');
  for (const directory of [data, workspace]) mkdirSync(directory);
  const requests = [];
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (mode === 'error') { res.writeHead(401).end('invalid key automation-key'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (mode === 'hang' && hangRequests.includes(requests.length)) { res.write(': waiting\n\n'); return; }
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'auto-1', function: { name: 'write', arguments: JSON.stringify({ file_path: 'result.txt', content: 'automation done' }) } }] } }] });
    } else {
      send({ choices: [{ delta: { content: '任务完成：已写入 result.txt' } }] });
      send({ usage: { prompt_tokens: 5, completion_tokens: 2 }, choices: [] });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const configFile = path.join(data, 'config.json');
  writeFileSync(configFile, JSON.stringify(configured ? {
    apiKey: 'automation-key', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'auto-model',
    protocol: 'openai', contextLimit: 40000, workspace, approval: 'normal',
  } : {}));
  const env = { ...process.env, TCODE_DATA_DIR: data, TCODE_ALLOW_WRITE: workspace };
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
  return { root, data, workspace, configFile, requests,
    state: async () => (await fetch(url + 'state')).json(),
    list: async () => { const response = await fetch(url + 'automations'); return { status: response.status, body: await response.json().catch(() => ({})) }; },
    post: async (route, body = {}) => { const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json().catch(() => ({})) }; },
    restart: async () => { await stop(); await start(); },
  };
}

test('创建自动化任务即在隔离会话后台执行：真实写入文件、结果与状态可查看', async (t) => {
  const h = await fixture(t);
  const created = await h.post('automations', { name: '夜间检查', prompt: '请写入 result.txt 内容为 automation done' });
  assert.equal(created.status, 200);
  const id = created.body.id;
  assert.ok(id);
  const done = await until(async () => (await h.list()).body.automations?.find((task) => task.id === id && task.status === 'completed'));
  assert.equal(done.resultText, '任务完成：已写入 result.txt');
  assert.equal(readFileSync(path.join(h.workspace, 'result.txt'), 'utf8'), 'automation done', '任务必须真实写入文件');
  assert.ok(done.sessionId, '任务会话独立留存，可回查完整过程');
  const list = (await h.list()).body;
  assert.equal(list.automations.length, 1);
  assert.equal(JSON.stringify(list).includes('automation-key'), false, '列表不能回显凭证');
});

test('运行中的任务可停止，停止后状态可见', async (t) => {
  const h = await fixture(t, { mode: 'hang' });
  const created = await h.post('automations', { name: '挂起任务', prompt: '慢慢做' });
  const id = created.body.id;
  await until(async () => (await h.list()).body.automations?.find((task) => task.id === id && task.status === 'running'));
  assert.equal((await h.post('automations/stop', { id })).status, 200);
  await until(async () => (await h.list()).body.automations?.find((task) => task.id === id && task.status === 'stopped'));
});

test('服务重启后运行中任务标记中断，可继续执行到完成', async (t) => {
  const h = await fixture(t, { mode: 'hang' });
  const created = await h.post('automations', { name: '跨重启任务', prompt: '分两步做' });
  const id = created.body.id;
  await until(async () => (await h.list()).body.automations?.find((task) => task.id === id && task.status === 'running'));
  await until(() => h.requests.length === 1); // 确认已挂在模型响应，避免恢复请求成为 fixture 的首次挂起请求
  const runningRequests = h.requests.length;
  await h.restart();
  const after = (await h.list()).body.automations.find((task) => task.id === id);
  assert.equal(after.status, 'interrupted', '重启后运行中任务必须标记中断');
  const resumed = await h.post('automations/resume', { id });
  assert.equal(resumed.status, 200);
  await until(async () => (await h.list()).body.automations?.find((task) => task.id === id && task.status === 'completed'));
  assert.ok(h.requests.length > runningRequests, '继续执行要发起新的模型请求');
});

test('未配置模型、空提示词、不存在的工作区都拒绝创建', async (t) => {
  const unconfigured = await fixture(t, { configured: false });
  assert.equal((await unconfigured.post('automations', { name: 'x', prompt: '做点什么' })).status, 400);
  const h = await fixture(t);
  assert.equal((await h.post('automations', { name: 'x', prompt: '   ' })).status, 400);
  assert.equal((await h.post('automations', { name: 'x', prompt: '做点什么', workspace: '/nonexistent-auto-project' })).status, 400);
  assert.equal((await h.list()).body.automations.length, 0);
});

test('周期任务：创建携带执行间隔并持久化下次触发时间，间隔非法拒绝', async (t) => {
  const h = await fixture(t);
  const created = await h.post('automations', { name: '每小时巡检', prompt: '巡检一次', intervalMinutes: 30 });
  assert.equal(created.status, 200);
  await until(async () => (await h.list()).body.automations.find((task) => task.id === created.body.id)?.status === 'completed');
  const listed = (await h.list()).body.automations.find((task) => task.id === created.body.id);
  assert.equal(listed.intervalMinutes, 30);
  assert.equal(listed.nextRunAt > Date.now(), true, '完成后应推进下次触发时间到未来');
  assert.equal((await h.post('automations', { name: '太快', prompt: 'x', intervalMinutes: 4 })).status, 400);
  assert.equal((await h.post('automations', { name: '非整数', prompt: 'x', intervalMinutes: 1.5 })).status, 400);
  assert.equal((await h.post('automations', { name: '不是数字', prompt: 'x', intervalMinutes: 'hourly' })).status, 400);
});

test('周期任务可暂停与恢复调度', async (t) => {
  const h = await fixture(t);
  const created = await h.post('automations', { name: '可暂停任务', prompt: '巡检', intervalMinutes: 60 });
  const id = created.body.id;
  await until(async () => (await h.list()).body.automations.find((task) => task.id === id)?.status === 'completed');
  const before = (await h.list()).body.automations.find((task) => task.id === id).nextRunAt;
  assert.equal((await h.post('automations/schedule', { id, paused: true })).status, 200);
  assert.equal((await h.list()).body.automations.find((task) => task.id === id).paused, true);
  assert.equal((await h.post('automations/schedule', { id, paused: false })).status, 200);
  const after = (await h.list()).body.automations.find((task) => task.id === id);
  assert.equal(after.paused, false);
  assert.equal(after.nextRunAt, before, '暂停期间 nextRunAt 不被改动');
});

test('已结束的任务可删除：任务记录与会话目录一并清理', async (t) => {
  const h = await fixture(t);
  const created = await h.post('automations', { name: '要删除的任务', prompt: '写 result.txt 内容为 automation done' });
  const id = created.body.id;
  await until(async () => (await h.list()).body.automations.find((task) => task.id === id)?.status === 'completed');
  assert.equal(existsSync(path.join(h.data, 'automations', id + '.json')), true);
  assert.equal(existsSync(path.join(h.data, 'automations', id, 'sessions')), true, '会话目录已留存');
  assert.equal((await h.post('automations/delete', { id })).status, 200);
  assert.equal(existsSync(path.join(h.data, 'automations', id + '.json')), false, '任务记录被清理');
  assert.equal(existsSync(path.join(h.data, 'automations', id)), false, '会话目录被清理');
  assert.equal((await h.list()).body.automations.length, 0);
  assert.equal((await h.post('automations/delete', { id })).status, 404, '重复删除返回 404');
});

test('运行中的任务拒绝删除', async (t) => {
  const h = await fixture(t, { mode: 'hang' });
  const created = await h.post('automations', { name: '运行中不可删', prompt: '慢慢做' });
  const id = created.body.id;
  await until(async () => (await h.list()).body.automations.find((task) => task.id === id)?.status === 'running');
  assert.equal((await h.post('automations/delete', { id })).status, 409);
  assert.equal((await h.post('automations/delete', { id: 'no-such' })).status, 404);
  assert.equal((await h.list()).body.automations.length, 1);
});

test('自动化运行期间与主会话轮次互斥：send 与第二个任务都被拒绝且提示明确', async (t) => {
  const h = await fixture(t, { mode: 'hang' });
  const first = await h.post('automations', { name: '占用任务', prompt: '慢慢做' });
  const id = first.body.id;
  await until(async () => (await h.list()).body.automations.find((task) => task.id === id)?.status === 'running');
  const send = await h.post('send', { text: '主会话任务' });
  assert.equal(send.status, 409);
  assert.match(send.body.error, /自动化/, '互斥提示须指向自动化任务');
  const second = await h.post('automations', { name: '第二个任务', prompt: '也做点什么' });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /自动化/);
  assert.equal((await h.list()).body.automations.filter((task) => task.name === '第二个任务').length, 0, '被拒绝的创建不产生任务记录');
  await h.post('automations/stop', { id });
  await until(async () => (await h.list()).body.automations.find((task) => task.id === id)?.status === 'stopped');
  const after = await h.post('send', { text: '恢复正常' });
  assert.equal(after.status, 200, '停止后主会话恢复可用');
});

test('worktree 清理端点：discard 移除目录与分支，未合并 merged 被 409 拒绝', async (t) => {
  const h = await fixture(t);
  const workspace = h.workspace;
  const git = (...args) => execFileSync('git', args, { cwd: workspace });
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  const create = await h.post('automations', { name: 'wt 任务', prompt: '写入 result.txt 内容为 automation done', worktree: true });
  assert.equal(create.status, 200);
  const id = create.body.id;
  await until(async () => (await h.list()).body.automations.find((task) => task.id === id)?.status === 'completed', '任务完成');
  const wtPath = path.join(h.data, 'automations', id, 'worktree');
  assert.equal(existsSync(path.join(wtPath, 'result.txt')), true, '任务写入 worktree');
  // 任务产出有独立 commit：分支领先主分支，merged 模式被 409 拒绝（分支保留供合并）
  const branch = `tcode-${id.slice(0, 8)}`;
  execFileSync('git', ['-C', wtPath, 'add', '.']);
  execFileSync('git', ['-C', wtPath, 'commit', '-m', 'task work']);
  const mergedRejected = await h.post('automations/worktree/remove', { id, mode: 'merged' });
  assert.equal(mergedRejected.status, 409, '未合并分支拒绝安全删除');
  assert.equal(existsSync(wtPath), true, '未合并时 worktree 保留');
  git('merge', branch);
  const removed = await h.post('automations/worktree/remove', { id, mode: 'merged' });
  assert.equal(removed.status, 200);
  assert.equal(existsSync(wtPath), false, 'worktree 已移除');
  assert.equal(existsSync(wtPath), false, 'worktree 已移除');
});

test('merged 清理固化失败时保留未提交产出，故障解除后可合并并重试', async (t) => {
  const h = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(h.workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  const created = await h.post('automations', { name: '固化失败', prompt: '写入 result.txt', worktree: true });
  const id = created.body.id;
  const task = await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'completed'));
  const branch = task.branch, wtPath = task.worktreePath;
  const tip = git('rev-parse', branch);
  const lock = path.resolve(wtPath, git('-C', wtPath, 'rev-parse', '--git-path', 'index.lock'));
  writeFileSync(lock, 'test lock', { flag: 'wx' });
  t.after(() => { if (existsSync(lock)) unlinkSync(lock); });

  const failed = await h.post('automations/worktree/remove', { id, mode: 'merged' });
  assert.equal(failed.status, 500, '固化失败必须报错，不能强删后返回成功');
  assert.equal(readFileSync(path.join(wtPath, 'result.txt'), 'utf8'), 'automation done');
  assert.equal(git('rev-parse', branch), tip, '失败不能推进或删除分支');
  assert.equal((await h.list()).body.automations.find((entry) => entry.id === id).worktreePath, wtPath);
  unlinkSync(lock);

  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 409);
  assert.equal(existsSync(wtPath), true, '固化成功但未合并时仍保留目录');
  git('merge', branch);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 200);
  assert.equal(readFileSync(path.join(h.workspace, 'result.txt'), 'utf8'), 'automation done');
});

for (const mode of ['merged', 'discard']) test(`${mode}：目录已移除但分支删除失败时可见剩余资源，重启后重试不产生空提交`, async (t) => {
  const h = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(h.workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  const created = await h.post('automations', { name: '分支删除失败', prompt: '写入 result.txt', worktree: true });
  const id = created.body.id;
  const task = await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'completed'));
  const branch = task.branch, wtPath = task.worktreePath;
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 409);
  git('merge', branch);
  const tip = git('rev-parse', branch);
  const lock = path.resolve(h.workspace, git('rev-parse', '--git-path', `refs/heads/${branch}.lock`));
  writeFileSync(lock, 'test lock', { flag: 'wx' });
  t.after(() => { if (existsSync(lock)) unlinkSync(lock); });

  assert.equal((await h.post('automations/worktree/remove', { id, mode })).status, 500);
  assert.equal(existsSync(wtPath), false, '目录已成功移除');
  const pending = (await h.list()).body.automations.find((entry) => entry.id === id);
  assert.equal(pending.worktreePath, undefined, '不能继续展示不存在的目录');
  assert.equal(pending.worktreeCleanupPending, true);
  assert.equal(pending.branch, branch, '剩余分支仍可审查和重试');
  assert.equal(git('rev-parse', branch), tip);
  assert.equal((await h.post('automations/delete', { id })).status, 409, '普通删除不能遗失剩余资源的记录');
  assert.equal((await h.post('automations/schedule', { id, paused: false })).status, 409);
  await h.restart();
  assert.equal((await h.list()).body.automations.find((entry) => entry.id === id).worktreeCleanupPending, true);
  unlinkSync(lock);

  assert.equal((await h.post('automations/worktree/remove', { id, mode })).status, 200);
  assert.equal(git('rev-parse', 'HEAD'), tip, '重试不能通过新空提交破坏已合并前提');
  assert.equal(git('branch', '--list', branch), '');
  const done = (await h.list()).body.automations.find((entry) => entry.id === id);
  assert.equal(done.worktreeCleanupPending, undefined);
  assert.equal(done.branch, undefined);
  assert.equal((await h.post('automations/delete', { id })).status, 200);
});

test('清理模式必须显式有效，普通删除不能绕过未提交产出的保护', async (t) => {
  const h = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(h.workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  const created = await h.post('automations', { name: '保护产出', prompt: '写入 result.txt', worktree: true });
  const id = created.body.id;
  const task = await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'completed'));
  for (const mode of [undefined, 'typo', null]) {
    assert.equal((await h.post('automations/worktree/remove', { id, mode })).status, 400);
    assert.equal(readFileSync(path.join(task.worktreePath, 'result.txt'), 'utf8'), 'automation done');
  }
  assert.equal((await h.post('automations/delete', { id })).status, 409);
  assert.equal(readFileSync(path.join(task.worktreePath, 'result.txt'), 'utf8'), 'automation done');
  assert.ok(git('branch', '--list', task.branch));
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'discard' })).status, 200);
  assert.equal(git('branch', '--list', task.branch), '');
  assert.equal((await h.post('automations/delete', { id })).status, 200);
});

test('任务分支不自动跟踪主分支，已有 upstream 的安全删除限制在移除目录前检查', async (t) => {
  const h = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  git('config', 'branch.autoSetupMerge', 'always');
  writeFileSync(path.join(h.workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  git('branch', '--no-track', 'older-upstream');
  const created = await h.post('automations', { name: '跟踪设置', prompt: '写入 result.txt', worktree: true });
  const id = created.body.id;
  const task = await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'completed'));
  assert.equal(git('for-each-ref', '--format=%(upstream)', `refs/heads/${task.branch}`), '', '创建必须独立于用户自动跟踪配置');
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 409);
  git('merge', task.branch);
  git('branch', '--set-upstream-to=older-upstream', task.branch);
  const failed = await h.post('automations/worktree/remove', { id, mode: 'merged' });
  assert.equal(failed.status, 409);
  assert.match(failed.body.error, /upstream|上游/);
  assert.equal(existsSync(task.worktreePath), true, 'HEAD 已合并但 upstream 未合并时仍保留目录');
  assert.equal(readFileSync(path.join(task.worktreePath, 'result.txt'), 'utf8'), 'automation done');
  assert.equal((await h.list()).body.automations.find((entry) => entry.id === id).worktreeCleanupPending, undefined, '预检拒绝不能进入部分清理状态');
  git('branch', '--unset-upstream', task.branch);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 200);
});

test('worktree 锁定时丢弃失败可见，解锁重试后目录和分支才清空', async (t) => {
  const h = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(h.workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  const created = await h.post('automations', { name: '锁定目录', prompt: '写入 result.txt', worktree: true });
  const id = created.body.id;
  const task = await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'completed'));
  git('worktree', 'lock', task.worktreePath);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'discard' })).status, 500);
  assert.equal(readFileSync(path.join(task.worktreePath, 'result.txt'), 'utf8'), 'automation done');
  assert.ok(git('branch', '--list', task.branch));
  const pending = (await h.list()).body.automations.find((entry) => entry.id === id);
  assert.equal(pending.worktreePath, task.worktreePath);
  assert.equal(pending.worktreeCleanupPending, true);
  assert.equal((await h.post('automations/delete', { id })).status, 409);
  git('worktree', 'unlock', task.worktreePath);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'discard' })).status, 200);
  assert.equal(existsSync(task.worktreePath), false);
  assert.equal(git('branch', '--list', task.branch), '');
});

test('损坏的路径引用不能清理外部目录，缺失引用也不能绕过真实 worktree 删除保护', async (t) => {
  const h = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(h.workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  const created = await h.post('automations', { name: '损坏记录', prompt: '写入 result.txt', worktree: true });
  const id = created.body.id;
  const task = await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'completed'));
  const record = path.join(h.data, 'automations', id + '.json');
  writeFileSync(record, JSON.stringify({ ...task, worktreePath: h.workspace }));
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'discard' })).status, 500);
  assert.equal(readFileSync(path.join(h.workspace, 'base.txt'), 'utf8'), 'base\n');
  assert.equal(readFileSync(path.join(task.worktreePath, 'result.txt'), 'utf8'), 'automation done');
  writeFileSync(record, JSON.stringify({ ...task, worktreePath: undefined }));
  assert.equal((await h.post('automations/delete', { id })).status, 409);
  assert.equal(readFileSync(path.join(task.worktreePath, 'result.txt'), 'utf8'), 'automation done');
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'discard' })).status, 200, '依据固定任务位置找到遗漏资源');
  assert.equal(existsSync(task.worktreePath), false);
  assert.equal(git('branch', '--list', task.branch), '');
});

test('用户隐藏未跟踪文件时安全清理仍固化产出，提交 hook 新增文件也必须保留', async (t) => {
  const h = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  git('config', 'status.showUntrackedFiles', 'no');
  writeFileSync(path.join(h.workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  const created = await h.post('automations', { name: '隐藏未跟踪文件', prompt: '写入 result.txt', worktree: true });
  const id = created.body.id;
  const task = await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'completed'));
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 409, '隐藏的产出也必须固化并要求合并');
  assert.equal(readFileSync(path.join(task.worktreePath, 'result.txt'), 'utf8'), 'automation done');
  git('merge', task.branch);
  const hook = path.resolve(h.workspace, git('rev-parse', '--git-path', 'hooks/post-commit'));
  const quotedWorkspace = "'" + h.workspace.replaceAll("'", "'\\''") + "'";
  writeFileSync(hook, `#!/bin/sh\nprintf "late output" > late-output.txt\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR\ngit -C ${quotedWorkspace} merge ${task.branch}\n`, { mode: 0o755 });
  t.after(() => { if (existsSync(hook)) unlinkSync(hook); });
  writeFileSync(path.join(task.worktreePath, 'result.txt'), 'updated');
  // hook 将新提交合入主分支，但留下新产出；祖先检查通过也不能删除这些字节。
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 500);
  assert.equal(readFileSync(path.join(task.worktreePath, 'late-output.txt'), 'utf8'), 'late output');
  assert.equal(readFileSync(path.join(h.workspace, 'result.txt'), 'utf8'), 'updated');
  unlinkSync(hook);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 409);
  git('merge', task.branch);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 200);
  assert.equal(readFileSync(path.join(h.workspace, 'late-output.txt'), 'utf8'), 'late output');
});

test('安全清理保留被忽略的唯一产出，不强制提交忽略内容，显式丢弃才移除', async (t) => {
  const h = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(h.workspace, '.gitignore'), 'result.txt\n');
  git('add', '.'); git('commit', '-m', 'init');
  const created = await h.post('automations', { name: '忽略产出', prompt: '写入 result.txt', worktree: true });
  const id = created.body.id;
  const task = await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'completed'));
  const tip = git('rev-parse', task.branch);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 500);
  assert.equal(readFileSync(path.join(task.worktreePath, 'result.txt'), 'utf8'), 'automation done');
  assert.equal(git('rev-parse', task.branch), tip, '忽略文件不能被自动强制加入提交');
  assert.equal((await h.list()).body.automations.find((entry) => entry.id === id).worktreeCleanupPending, undefined);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'discard' })).status, 200);
  assert.equal(existsSync(task.worktreePath), false);
  assert.equal(git('branch', '--list', task.branch), '');
});

test('worktree 创建命令部分失败仍保留资源记录，拒绝重跑并可显式清理', async (t) => {
  const h = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(h.workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  const hook = path.resolve(h.workspace, git('rev-parse', '--git-path', 'hooks/post-checkout'));
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  t.after(() => { if (existsSync(hook)) unlinkSync(hook); });
  const created = await h.post('automations', { name: '部分创建失败', prompt: '写入 result.txt', worktree: true });
  const id = created.body.id;
  const task = await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'error'));
  assert.equal(h.requests.length, 0, '准备失败不能调用模型');
  assert.equal(task.worktreeCleanupPending, true);
  assert.equal(existsSync(task.worktreePath), true);
  assert.ok(git('branch', '--list', task.branch));
  assert.equal((await h.post('automations/resume', { id })).status, 409);
  assert.equal((await h.post('automations/delete', { id })).status, 409);
  unlinkSync(hook);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'discard' })).status, 200);
  assert.equal(existsSync(task.worktreePath), false);
  assert.equal(git('branch', '--list', task.branch), '');
  const next = await h.post('automations', { name: '后续任务', prompt: '继续使用主工作区' });
  assert.equal(next.status, 200, '准备失败后全局运行状态必须释放');
  await until(async () => (await h.list()).body.automations.find((entry) => entry.id === next.body.id && entry.status === 'completed'));
});

test('继续任务与创建任务均不能绕过主会话或另一自动化的互斥', async (t) => {
  const h = await fixture(t, { mode: 'hang', hangRequests: [1, 2] });
  const record = { id: 'previous-task', name: '旧任务', prompt: '继续使用', workspace: h.workspace, status: 'interrupted', createdAt: 1 };
  const file = path.join(h.data, 'automations', record.id + '.json');
  writeFileSync(file, JSON.stringify(record));
  assert.equal((await h.post('send', { text: '挂起的主会话' })).status, 200);
  await until(() => h.requests.length === 1);
  assert.equal((await h.post('automations', { name: '抢占主会话', prompt: '也执行' })).status, 409);
  assert.equal((await h.post('automations/resume', { id: record.id })).status, 409);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), record);
  assert.equal((await h.post('abort')).status, 200);
  await until(async () => !(await h.state()).busy);
  const first = await h.post('automations', { name: '占用任务', prompt: '慢慢做' });
  assert.equal(first.status, 200);
  const id = first.body.id;
  await until(() => h.requests.length === 2);
  assert.equal((await h.post('automations/resume', { id: record.id })).status, 409);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), record);
  assert.equal((await h.post('automations/stop', { id })).status, 200);
  await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'stopped'));
  assert.equal((await h.post('automations/resume', { id: record.id })).status, 200);
  await until(async () => (await h.list()).body.automations.find((entry) => entry.id === record.id && entry.status === 'completed'));
});

test('任务分支引用缺失时安全清理拒绝重建提交，显式丢弃仍可清理', async (t) => {
  const h = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(h.workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  const created = await h.post('automations', { name: '引用缺失', prompt: '写入 result.txt', worktree: true });
  const id = created.body.id;
  const task = await until(async () => (await h.list()).body.automations.find((entry) => entry.id === id && entry.status === 'completed'));
  git('update-ref', '-d', `refs/heads/${task.branch}`);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'merged' })).status, 500);
  assert.equal(readFileSync(path.join(task.worktreePath, 'result.txt'), 'utf8'), 'automation done');
  assert.equal(git('branch', '--list', task.branch), '', '不能通过自动提交重建损坏的分支引用');
  const retained = (await h.list()).body.automations.find((entry) => entry.id === id);
  assert.equal(retained.worktreePath, task.worktreePath);
  assert.equal(retained.worktreeCleanupPending, undefined);
  assert.equal((await h.post('automations/worktree/remove', { id, mode: 'discard' })).status, 200);
  assert.equal(existsSync(task.worktreePath), false);
  assert.equal(git('branch', '--list', task.branch), '');
});
