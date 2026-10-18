// Git 审查与撤销闭环：逐文件变更、修改前快照、选择性撤销、暂存与提交。
// 已确认公共边界：本地 HTTP 端点 + 真实 Git 仓库与真实文件；模型为外部假端点。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs';
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

function git(workspace, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: workspace, encoding: 'utf8' });
}

function initRepo(workspace, files) {
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  git(workspace, 'config', 'user.name', '测试用户');
  git(workspace, 'config', 'user.email', 'test@example.com');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(workspace, name), content);
  }
  git(workspace, 'add', '.');
  git(workspace, 'commit', '--quiet', '-m', 'base');
}

async function harness(t, subdirectory = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-git-'));
  const workspace = path.join(dir, 'project');
  const selectedWorkspace = path.join(workspace, subdirectory);
  mkdirSync(selectedWorkspace, { recursive: true });
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const user = body.messages.findLast((m) => m.role === 'user')?.content ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const hasResult = body.messages.slice(body.messages.findLastIndex((m) => m.role === 'user') + 1).some((m) => m.role === 'tool');
    if ((user === 'edit' || user === 'edit-alias' || user === 'edit-large') && !hasResult) {
      const file = user === 'edit-alias' ? path.join(dir, 'workspace-alias', 'tracked.txt') : user === 'edit-large' ? 'large.txt' : 'tracked.txt';
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'edit-1', function: { name: 'edit', arguments: JSON.stringify({ file_path: file, old_string: 'world', new_string: 'agent' }) } }] } }] });
    } else if (user === 'bash-write' && !hasResult) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'bash-1', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf "bash change\\n" > bash.txt' }) } }] } }] });
    } else if (user === 'patch' && !hasResult) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'patch-1', function: { name: 'apply_patch', arguments: JSON.stringify({ edits: [{ file_path: 'tracked.txt', old_string: 'world', new_string: 'agent' }] }) } }] } }] });
    } else if ((user === 'write' || user === 'write-alias') && !hasResult) {
      const file = user === 'write-alias' ? path.join(dir, 'workspace-alias', 'fresh.txt') : 'fresh.txt';
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write-1', function: { name: 'write', arguments: JSON.stringify({ file_path: file, content: 'brand new file' }) } }] } }] });
    } else if (user === 'slow' && !hasResult) {
      res.write(': wait\n\n');
      return;
    } else {
      send({ choices: [{ delta: { content: `回答：${user}` } }] });
      send({ usage: { prompt_tokens: 11, completion_tokens: 7 }, choices: [] });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  const env = {
    ...process.env, TCODE_DATA_DIR: path.join(dir, 'data'), TCODE_TEST_WORKSPACE: selectedWorkspace,
    TCODE_TEST_PROVIDER: endpoint, TCODE_API_KEY: 'test-key',
    TCODE_BASE_URL: endpoint, TCODE_MODEL: 'fake-model',
    TCODE_PROTOCOL: '', TCODE_APPROVAL: 'normal', TCODE_ALLOW_WRITE: '',
  };
  const child = spawn(process.execPath, ['test/web-fixture.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const get = async (route) => {
    const response = await fetch(url + route, { cache: 'no-store' });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const event = (type, from = 0) => until(() => events.slice(from).find((value) => value.type === type), type);
  /** 走完一次带审批的编辑轮，返回 turn_end 事件 */
  const approvedTurn = async (text) => {
    const mark = events.length;
    await post('send', { text });
    const pending = await event('permission', mark);
    const allowed = await post('permission', { id: pending.id, decision: 'allow' });
    assert.equal(allowed.status, 200);
    return event('turn_end', mark);
  };
  return { url, post, get, event, events, workspace, dir, approvedTurn };
}

const findFile = (body, name) => (body.files ?? []).find((file) => file.path === name);

test('逐文件变更列出已跟踪修改、新文件与暂存状态，且不改变暂存区', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'hello world\n' });
  writeFileSync(path.join(h.workspace, 'tracked.txt'), 'hello world\n本地修改\n');
  writeFileSync(path.join(h.workspace, 'new.txt'), 'untracked\n');
  writeFileSync(path.join(h.workspace, '中文.txt'), '中文新内容\n');
  git(h.workspace, 'add', 'new.txt');
  const before = git(h.workspace, 'status', '--porcelain');
  const response = await h.get('changes');
  assert.equal(response.status, 200);
  assert.equal(git(h.workspace, 'status', '--porcelain'), before, '读取变更不能改变暂存区');
  const tracked = findFile(response.body, 'tracked.txt');
  assert.ok(tracked, '已跟踪修改必须列出');
  assert.equal(tracked.untracked, false);
  assert.equal(tracked.staged, false);
  assert.equal(tracked.revertable, false, '没有快照的文件不可撤销');
  assert.match(tracked.diff, / hello world/);
  assert.match(tracked.diff, /\+本地修改/);
  const staged = findFile(response.body, 'new.txt');
  assert.ok(staged, '已暂存的新文件必须列出');
  assert.equal(staged.staged, true);
  assert.equal(staged.untracked, true);
  assert.match(staged.diff, /\+untracked/);
  const chinese = findFile(response.body, '中文.txt');
  assert.ok(chinese, '变更面板须能读取中文文件名');
  assert.match(chinese.diff, /\+中文新内容/);
});

test('非 Git 目录返回可见错误而不是崩溃', async (t) => {
  const h = await harness(t);
  const response = await h.get('changes');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.files, []);
  assert.ok(response.body.error, '必须给出错误说明');
});

test('撤销把文件恢复到本轮修改前状态，保留用户未提交的编辑', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'hello world\n' });
  // 用户先有一份未提交的本地编辑，agent 的编辑不能覆盖掉这份基线
  writeFileSync(path.join(h.workspace, 'tracked.txt'), 'hello world\n用户笔记\n');
  await h.approvedTurn('edit');
  assert.equal(readFileSync(path.join(h.workspace, 'tracked.txt'), 'utf8'), 'hello agent\n用户笔记\n');
  const listed = findFile(await h.get('changes').then((r) => r.body), 'tracked.txt');
  assert.equal(listed.revertable, true);
  assert.ok(readdirSync(path.join(h.dir, 'data', 'file-journal')).length >= 1, '快照必须落盘以支持重启后撤销');
  const reverted = await h.post('changes/revert', { path: 'tracked.txt' });
  assert.equal(reverted.status, 200);
  assert.equal(readFileSync(path.join(h.workspace, 'tracked.txt'), 'utf8'), 'hello world\n用户笔记\n', '撤销恢复到快照（含用户编辑），不是 HEAD');
  const after = findFile(reverted.body.changes, 'tracked.txt');
  assert.equal(after.revertable, false, '撤销后快照已消费');
  assert.equal(after.staged, false);
  assert.match(after.diff, /\+用户笔记/, '用户的编辑仍然可见');
});

test('撤销 agent 新建的文件会删除它', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'base\n' });
  await h.approvedTurn('write');
  assert.equal(readFileSync(path.join(h.workspace, 'fresh.txt'), 'utf8'), 'brand new file');
  const listed = findFile(await h.get('changes').then((r) => r.body), 'fresh.txt');
  assert.equal(listed.revertable, true);
  assert.equal(listed.untracked, true);
  const reverted = await h.post('changes/revert', { path: 'fresh.txt' });
  assert.equal(reverted.status, 200);
  assert.equal(reverted.body.changes.files.some((file) => file.path === 'fresh.txt'), false, '删除后不再出现在变更列表');
});

test('子目录工作区用变更面板的仓库根路径撤销真实 Agent 快照，保留同名嵌套文件', async (t) => {
  const h = await harness(t, 'src');
  mkdirSync(path.join(h.workspace, 'src', 'src'), { recursive: true });
  initRepo(h.workspace, {
    'src/tracked.txt': 'hello world\n',
    'src/src/tracked.txt': 'hello world\nnested baseline\n',
  });
  const selected = path.join(h.workspace, 'src/tracked.txt');
  const nested = path.join(h.workspace, 'src/src/tracked.txt');
  writeFileSync(selected, 'hello world\n用户笔记\n');
  await h.approvedTurn('edit');
  assert.equal(readFileSync(selected, 'utf8'), 'hello agent\n用户笔记\n');
  const listed = findFile((await h.get('changes')).body, 'src/tracked.txt');
  assert.equal(listed.revertable, true, '变更面板须提供真实快照的撤销入口');
  const reverted = await h.post('changes/revert', { path: listed.path });
  assert.equal(reverted.status, 200, '变更面板提供的仓库根路径须能消费当前工作区的快照');
  assert.equal(readFileSync(selected, 'utf8'), 'hello world\n用户笔记\n', '撤销保留 Agent 修改前用户的编辑');
  assert.equal(readFileSync(nested, 'utf8'), 'hello world\nnested baseline\n', '同名嵌套文件不得被修改');
  assert.equal(findFile(reverted.body.changes, 'src/tracked.txt').revertable, false, '消费后撤销快照不可再次使用');
});

test('快照之后又被手动修改的文件拒绝撤销并保持内容不变', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'hello world\n' });
  await h.approvedTurn('edit');
  writeFileSync(path.join(h.workspace, 'tracked.txt'), 'hello agent\n手动补充\n');
  const conflicted = await h.post('changes/revert', { path: 'tracked.txt' });
  assert.equal(conflicted.status, 409);
  assert.ok(conflicted.body.error.includes('手动'), '冲突说明必须提示后续编辑');
  assert.equal(readFileSync(path.join(h.workspace, 'tracked.txt'), 'utf8'), 'hello agent\n手动补充\n', '拒绝撤销时不能改文件');
});

test('本轮快照筛选仍展示同路径用户编辑，重复读取不改文件与索引，下一轮清空范围', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'hello world\n', 'user.txt': 'base\n' });
  writeFileSync(path.join(h.workspace, 'tracked.txt'), 'hello world\n轮前用户编辑\n');
  writeFileSync(path.join(h.workspace, 'user.txt'), '用户独立改动\n');
  git(h.workspace, 'add', 'user.txt');
  await h.approvedTurn('edit');
  writeFileSync(path.join(h.workspace, 'tracked.txt'), 'hello agent\n轮前用户编辑\n轮后用户编辑\n');
  const index = git(h.workspace, 'diff', '--cached');
  const bytes = readFileSync(path.join(h.workspace, 'tracked.txt'), 'utf8');
  for (let i = 0; i < 2; i++) {
    const changes = (await h.get('changes')).body;
    const snapshots = changes.files.filter((file) => file.revertable);
    assert.deepEqual(snapshots.map((file) => file.path), ['tracked.txt']);
    assert.match(snapshots[0].diff, /\+轮前用户编辑/);
    assert.match(snapshots[0].diff, /\+轮后用户编辑/, '快照标记不能把整段 HEAD diff 说成 Agent 独有');
    assert.equal(findFile(changes, 'user.txt').revertable, false);
  }
  assert.equal(git(h.workspace, 'diff', '--cached'), index, '范围读取不能改暂存区');
  assert.equal(readFileSync(path.join(h.workspace, 'tracked.txt'), 'utf8'), bytes);
  const mark = h.events.length;
  assert.equal((await h.post('send', { text: 'plain next round' })).status, 200);
  await h.event('turn_end', mark);
  const next = (await h.get('changes')).body;
  assert.deepEqual(next.files.filter((file) => file.revertable), [], '新一轮没有工具快照，不能继续显示上一轮归因');
  assert.match(findFile(next, 'tracked.txt').diff, /\+hello agent/, '仅清空快照范围，不回滚工作区');
  assert.equal(git(h.workspace, 'diff', '--cached'), index);
  assert.equal(readFileSync(path.join(h.workspace, 'tracked.txt'), 'utf8'), bytes);
});

test('模型使用真实文件的目录别名时仍能按仓库路径筛选快照并安全撤销', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'hello world\n' });
  symlinkSync(h.workspace, path.join(h.dir, 'workspace-alias'), 'dir');
  writeFileSync(path.join(h.workspace, 'tracked.txt'), 'hello world\n用户笔记\n');
  await h.approvedTurn('edit-alias');
  assert.equal(readFileSync(path.join(h.workspace, 'tracked.txt'), 'utf8'), 'hello agent\n用户笔记\n');
  const changes = (await h.get('changes')).body;
  assert.deepEqual(changes.files.filter((file) => file.revertable).map((file) => file.path), ['tracked.txt']);
  const reverted = await h.post('changes/revert', { path: 'tracked.txt' });
  assert.equal(reverted.status, 200);
  assert.equal(readFileSync(path.join(h.workspace, 'tracked.txt'), 'utf8'), 'hello world\n用户笔记\n');
  assert.equal(findFile(reverted.body.changes, 'tracked.txt').revertable, false);
  await h.approvedTurn('write-alias');
  assert.equal(findFile((await h.get('changes')).body, 'fresh.txt').revertable, true);
  const removed = await h.post('changes/revert', { path: 'fresh.txt' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.changes.files.some((file) => file.path === 'fresh.txt'), false);
  const journalDirectory = path.join(h.dir, 'data', 'file-journal');
  const remaining = readdirSync(journalDirectory).filter((file) => file.endsWith('.json'))
    .flatMap((file) => JSON.parse(readFileSync(path.join(journalDirectory, file), 'utf8')));
  assert.deepEqual(remaining, [], '别名新文件撤销删除后仍须消费原始路径快照，不能留下失效的恢复记录');
});

test('目录别名重指相同写后内容的另一文件时，不得转移快照或撤销目标', async (t) => {
  const h = await harness(t);
  mkdirSync(path.join(h.workspace, 'replacement'));
  initRepo(h.workspace, {
    'tracked.txt': 'hello world\n原目标笔记\n',
    'replacement/tracked.txt': '新目标基线\n',
  });
  const alias = path.join(h.dir, 'workspace-alias');
  const original = path.join(h.workspace, 'tracked.txt');
  const replacement = path.join(h.workspace, 'replacement', 'tracked.txt');
  symlinkSync(h.workspace, alias, 'dir');
  await h.approvedTurn('edit-alias');
  const postWrite = readFileSync(original, 'utf8');
  unlinkSync(alias); symlinkSync(path.dirname(replacement), alias, 'dir');
  writeFileSync(replacement, postWrite); // 刻意匹配 postSha，不能只依赖字节指纹证明文件身份
  const changes = (await h.get('changes')).body;
  assert.equal(findFile(changes, 'replacement/tracked.txt').revertable, false, '快照须属于实际写入时的原目标');
  assert.equal(findFile(changes, 'tracked.txt').revertable, true);
  const rejected = await h.post('changes/revert', { path: 'replacement/tracked.txt' });
  assert.ok([404, 409].includes(rejected.status), '不能把原目标快照写进新目标');
  assert.equal(readFileSync(replacement, 'utf8'), postWrite);
  const reverted = await h.post('changes/revert', { path: 'tracked.txt' });
  assert.equal(reverted.status, 200, '原目标真实路径仍可安全撤销');
  assert.equal(readFileSync(original, 'utf8'), 'hello world\n原目标笔记\n');
  assert.equal(readFileSync(replacement, 'utf8'), postWrite, '原目标撤销也不能经过已重指的别名');
});

test('旧日志中的词法别名路径不得在重指后重新归属于新目标', async (t) => {
  const h = await harness(t);
  mkdirSync(path.join(h.workspace, 'replacement'));
  initRepo(h.workspace, {
    'tracked.txt': 'hello world\n原目标笔记\n',
    'replacement/tracked.txt': '新目标基线\n',
  });
  const alias = path.join(h.dir, 'workspace-alias');
  const replacement = path.join(h.workspace, 'replacement', 'tracked.txt');
  symlinkSync(h.workspace, alias, 'dir');
  await h.approvedTurn('edit-alias');
  const journalDirectory = path.join(h.dir, 'data', 'file-journal');
  for (const file of readdirSync(journalDirectory).filter((file) => file.endsWith('.json'))) {
    const journalFile = path.join(journalDirectory, file);
    const entries = JSON.parse(readFileSync(journalFile, 'utf8'));
    entries.forEach((entry) => { entry.path = path.join(alias, 'tracked.txt'); });
    writeFileSync(journalFile, JSON.stringify(entries)); // 模拟旧版本确实存过的未固化路径
  }
  const postWrite = readFileSync(path.join(h.workspace, 'tracked.txt'), 'utf8');
  unlinkSync(alias); symlinkSync(path.dirname(replacement), alias, 'dir');
  writeFileSync(replacement, postWrite);
  const changes = (await h.get('changes')).body;
  assert.deepEqual(changes.files.filter((file) => file.revertable), [], '旧别名记录无法证明原落点，应拒绝自动归属');
  for (const target of ['replacement/tracked.txt', path.join(alias, 'tracked.txt')]) {
    const rejected = await h.post('changes/revert', { path: target });
    assert.ok([404, 409].includes(rejected.status), '真实路径及别名路径都不得重新使用旧记录');
    assert.equal(readFileSync(replacement, 'utf8'), postWrite);
  }
});

test('超大原文编辑和 bash 写入保留在仓库范围，不冒充有快照的本轮文件', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'large.txt': 'hello world\n' + 'x'.repeat(1024 * 1024), 'bash.txt': 'base\n' });
  await h.approvedTurn('edit-large');
  const large = findFile((await h.get('changes')).body, 'large.txt');
  assert.ok(large, '超大文件真实 Git 变更仍须列出');
  assert.equal(large.revertable, false, '超过快照上限的原文不属于快照范围');
  assert.equal(readFileSync(path.join(h.workspace, 'large.txt'), 'utf8').startsWith('hello agent\n'), true);
  await h.approvedTurn('bash-write');
  const changes = (await h.get('changes')).body;
  assert.match(findFile(changes, 'bash.txt').diff, /\+bash change/);
  assert.deepEqual(changes.files.filter((file) => file.revertable), [], 'bash 是任意命令，现有 journal 不记录其写入');
});

for (const tool of ['apply_patch', 'edit']) test(`${tool} 实际写入失败不记录快照，成功写入仍可撤销`, { skip: process.getuid?.() === 0 }, async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'hello world\n' });
  const target = path.join(h.workspace, 'tracked.txt');
  t.after(() => chmodSync(target, 0o600));
  chmodSync(target, 0o400);
  const turn = tool === 'apply_patch' ? 'patch' : 'edit';
  await h.approvedTurn(turn);
  assert.equal(readFileSync(target, 'utf8'), 'hello world\n', '必须实际发生文件系统拒写，而不是模型未调用补丁');
  assert.ok(h.events.some((event) => event.type === 'tool_call' && event.name === tool));
  chmodSync(target, 0o600);
  writeFileSync(target, 'hello agent\n'); // 用户后续恰好写入相同计划内容，不能消费失败写入的快照
  const changes = (await h.get('changes')).body;
  assert.equal(findFile(changes, 'tracked.txt').revertable, false);
  assert.equal((await h.post('changes/revert', { path: 'tracked.txt' })).status, 404);
  assert.equal(readFileSync(target, 'utf8'), 'hello agent\n');
  writeFileSync(target, 'hello world\n用户新笔记\n');
  await h.approvedTurn(turn);
  assert.equal(readFileSync(target, 'utf8'), 'hello agent\n用户新笔记\n');
  assert.equal(findFile((await h.get('changes')).body, 'tracked.txt').revertable, true, '成功写入仍须记录快照，不能直接删除记录逻辑');
  assert.equal((await h.post('changes/revert', { path: 'tracked.txt' })).status, 200);
  assert.equal(readFileSync(target, 'utf8'), 'hello world\n用户新笔记\n');
});

test('没有快照的文件不可通过撤销接口改动', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'hello world\n' });
  writeFileSync(path.join(h.workspace, 'tracked.txt'), '手动改动\n');
  const missing = await h.post('changes/revert', { path: 'tracked.txt' });
  assert.equal(missing.status, 404);
  assert.equal(readFileSync(path.join(h.workspace, 'tracked.txt'), 'utf8'), '手动改动\n');
  const outside = await h.post('changes/revert', { path: '../escape.txt' });
  assert.equal(outside.status, 404, '快照表之外的路径一律拒绝');
});

test('暂存、取消暂存与提交走真实 Git 索引', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'hello world\n', 'other.txt': 'keep\n' });
  writeFileSync(path.join(h.workspace, 'tracked.txt'), 'hello agent\n');
  writeFileSync(path.join(h.workspace, 'other.txt'), 'keep\n本地改动\n');
  const bad = await h.post('changes/stage', { paths: ['../evil'], staged: true });
  assert.equal(bad.status, 400, '不在变更列表内的路径必须拒绝');
  const staged = await h.post('changes/stage', { paths: ['tracked.txt'], staged: true });
  assert.equal(staged.status, 200);
  assert.match(git(h.workspace, 'diff', '--cached'), /hello agent/);
  assert.equal(findFile(staged.body.changes, 'tracked.txt').staged, true);
  const unstaged = await h.post('changes/stage', { paths: ['tracked.txt'], staged: false });
  assert.equal(unstaged.status, 200);
  assert.equal(git(h.workspace, 'diff', '--cached', '--stat').trim(), '', '取消暂存必须清空该文件的暂存区');
  await h.post('changes/stage', { paths: ['tracked.txt'], staged: true });
  const empty = await h.post('changes/commit', { message: '' });
  assert.equal(empty.status, 400, '空提交说明必须拒绝');
  const committed = await h.post('changes/commit', { message: '接入 agent 修改' });
  assert.equal(committed.status, 200);
  const log = git(h.workspace, 'log', '-1', '--format=%s');
  assert.match(log, /接入 agent 修改/);
  assert.match(git(h.workspace, 'show', '--stat', '--format='), /tracked.txt/, '提交只包含暂存文件');
  assert.equal(findFile(committed.body.changes, 'tracked.txt'), undefined, '已提交文件不再是变更');
  assert.ok(findFile(committed.body.changes, 'other.txt'), '未暂存的文件保持原状');
});

test('没有暂存内容时提交被拒绝', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'hello world\n' });
  writeFileSync(path.join(h.workspace, 'tracked.txt'), 'hello agent\n');
  const nothing = await h.post('changes/commit', { message: '空提交' });
  assert.equal(nothing.status, 409);
  assert.equal(git(h.workspace, 'log', '--oneline').trim().split('\n').length, 1, '不能产生空提交');
});

test('子目录工作区按仓库根路径查看、暂存、取消暂存和提交，不误操作同名嵌套文件', async (t) => {
  const h = await harness(t, 'src');
  mkdirSync(path.join(h.workspace, 'src', 'src'), { recursive: true });
  initRepo(h.workspace, {
    'src/a.txt': 'selected base\n',
    'src/src/a.txt': 'nested base\n',
  });
  writeFileSync(path.join(h.workspace, 'src/a.txt'), 'selected change\n');
  writeFileSync(path.join(h.workspace, 'src/src/a.txt'), 'nested change\n');

  const changes = await h.get('changes');
  assert.equal(changes.status, 200);
  assert.match(findFile(changes.body, 'src/a.txt').diff, /\+selected change/);
  assert.doesNotMatch(findFile(changes.body, 'src/a.txt').diff, /nested change/);
  assert.match(findFile(changes.body, 'src/src/a.txt').diff, /\+nested change/);

  const staged = await h.post('changes/stage', { paths: ['src/a.txt'], staged: true });
  assert.equal(staged.status, 200);
  assert.equal(git(h.workspace, 'diff', '--cached', '--name-only'), 'src/a.txt\n', '暂存选择项，不能把同名嵌套文件误加入索引');
  assert.equal(git(h.workspace, 'show', ':src/a.txt'), 'selected change\n');
  assert.equal(git(h.workspace, 'show', ':src/src/a.txt'), 'nested base\n');

  git(h.workspace, 'add', '--', 'src/src/a.txt');
  const unstaged = await h.post('changes/stage', { paths: ['src/a.txt'], staged: false });
  assert.equal(unstaged.status, 200);
  assert.equal(git(h.workspace, 'diff', '--cached', '--name-only'), 'src/src/a.txt\n', '取消暂存只影响所选文件，保留其他暂存');
  assert.equal(git(h.workspace, 'show', ':src/a.txt'), 'selected base\n');
  assert.equal(git(h.workspace, 'show', ':src/src/a.txt'), 'nested change\n');

  git(h.workspace, 'reset', '--quiet', 'HEAD', '--', 'src/src/a.txt');
  assert.equal((await h.post('changes/stage', { paths: ['src/a.txt'], staged: true })).status, 200);
  const committed = await h.post('changes/commit', { message: 'commit selected from subdirectory' });
  assert.equal(committed.status, 200);
  assert.equal(git(h.workspace, 'show', '--format=', '--name-only'), 'src/a.txt\n');
  assert.equal(git(h.workspace, 'show', 'HEAD:src/a.txt'), 'selected change\n');
  assert.equal(git(h.workspace, 'show', 'HEAD:src/src/a.txt'), 'nested base\n', '未选文件不能进入提交');
  assert.match(findFile(committed.body.changes, 'src/src/a.txt').diff, /\+nested change/);
});

test('任务运行期间禁止撤销、暂存和提交', async (t) => {
  const h = await harness(t);
  initRepo(h.workspace, { 'tracked.txt': 'hello world\n' });
  writeFileSync(path.join(h.workspace, 'tracked.txt'), 'hello agent\n');
  const mark = h.events.length;
  await h.post('send', { text: 'slow' });
  await h.event('turn_start', mark);
  assert.equal((await h.post('changes/revert', { path: 'tracked.txt' })).status, 409);
  assert.equal((await h.post('changes/stage', { paths: ['tracked.txt'], staged: true })).status, 409);
  assert.equal((await h.post('changes/commit', { message: 'run' })).status, 409);
  await h.post('abort', {});
  await h.event('turn_end', mark);
});
