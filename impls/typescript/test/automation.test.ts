// 定时调度单测：注入时钟 + 假 provider，进程内验证 nextRunAt 推进、到期触发、暂停冻结。
// HTTP/CLI 全链路回归在 web-automation.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutomationRunner, type AutomationTask } from '../src/core/automation.ts';
import { SessionStore } from '../src/core/session.ts';
import writePlugin from '../src/plugins/tools/write.ts';
import { buildSystemPrompt } from '../src/core/systemprompt.ts';
import { resolvePath } from '../src/plugins/tools/pathguard.ts';
import type { App } from '../src/kernel/app.ts';

function setup(t: TestContext, now: () => number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-auto-sched-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const runner = new AutomationRunner(dir, now);
  const requests: Array<{ messages: Array<{ role: string; content?: string | null }> }> = [];
  let blocked: Promise<void> | null = null;
  let releaseBlocked: () => void = () => {};
  const app = {
    provider: {
      chat: async (messages: Array<{ role: string; content?: string | null }>) => {
        requests.push({ messages });
        if (blocked) await blocked;
        const hasToolResult = messages.some((m) => m.role === 'tool');
        if (!hasToolResult && messages.findLast((m) => m.role === 'user')?.content?.includes('写入')) {
          return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: 'out/hello.txt', content: 'hello' }) } }] } };
        }
        return { message: { role: 'assistant', content: '调度完成' } };
      },
    },
    registry: { tools: () => [writePlugin], commands: () => [] },
    config: { tcodeDir: dir, contextLimit: 100000, apiKey: 'k', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' },
    messages: [] as unknown[],
    store: new SessionStore(path.join(dir, 'main-sessions')),
    yolo: { value: false },
    planMode: { value: false },
  } as unknown as App;
  t.after(() => { for (const task of runner.list()) if (task.status === 'running') runner.stop(task.id); });
  return {
    runner, app, requests, dir, workspace,
    block: () => { blocked = new Promise((resolve) => { releaseBlocked = resolve; }); },
    release: () => releaseBlocked(),
  };
}

const waitRunning = async (runner: AutomationRunner, id: string) => {
  // WP2：治理中间件使首个模型请求比空管线晚几个微任务发出，先让出一个宏任务，
  // 保证「已运行 + 请求已发出」两个条件在同一时点成立（断言语义不变）。
  await new Promise((resolve) => setTimeout(resolve, 0));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (runner.isRunning(id)) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('任务未进入运行状态');
};
const waitDone = async (runner: AutomationRunner, id: string) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const task = runner.get(id);
    if (task && task.status !== 'running') return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('任务未结束');
};

test('创建带间隔的任务：立即执行一次，完成后按间隔推进下次触发时间并持久化', async (t) => {
  let clock = 1_000_000;
  const { runner, app, dir } = setup(t, () => clock);
  const task = runner.create({ name: '每日检查', prompt: '做检查', workspace: process.cwd(), intervalMinutes: 30 });
  assert.equal(task.nextRunAt, undefined, '首次执行前没有下次触发时间');
  const execute = runner.execute(app, task.id);
  const done = await waitDone(runner, task.id);
  await execute;
  assert.equal(done.status, 'completed');
  assert.equal(done.nextRunAt, 1_000_000 + 30 * 60_000, '完成后 nextRunAt = 完成时刻 + 间隔');
  const persisted = JSON.parse(readFileSync(path.join(dir, 'automations', task.id + '.json'), 'utf8')) as AutomationTask;
  assert.equal(persisted.intervalMinutes, 30, '间隔必须持久化');
  assert.equal(persisted.nextRunAt, 1_000_000 + 30 * 60_000, '下次触发时间必须持久化');
});

test('到期的周期任务由调度触发执行并再次推进；未到期与已暂停不触发', async (t) => {
  let clock = 2_000_000;
  const { runner, app, requests } = setup(t, () => clock);
  const task = runner.create({ name: '巡检', prompt: '巡检项目', workspace: process.cwd() });
  runner.setSchedule(task.id, { intervalMinutes: 10, nextRunAt: clock - 1, paused: false });
  await runner.tick(app);
  await waitDone(runner, task.id);
  assert.equal(requests.length, 1, '到期触发一次执行');
  const after = runner.get(task.id)!;
  assert.equal(after.nextRunAt, 2_000_000 + 10 * 60_000, '触发后推进一个间隔');

  // 未到期不触发
  clock = after.nextRunAt! - 1;
  await runner.tick(app);
  assert.equal(requests.length, 1);

  // 暂停：即使到期也冻结并持续顺延
  runner.setSchedule(task.id, { paused: true });
  clock = after.nextRunAt! + 60_000;
  await runner.tick(app);
  assert.equal(requests.length, 1, '暂停的任务不执行');
  assert.equal(runner.get(task.id)!.nextRunAt, clock + 10 * 60_000, '暂停期间 nextRunAt 顺延');
  assert.equal(runner.get(task.id)!.paused, true);

  // 恢复调度后到期可再触发
  runner.setSchedule(task.id, { paused: false });
  clock = runner.get(task.id)!.nextRunAt! + 1;
  await runner.tick(app);
  await waitDone(runner, task.id);
  assert.equal(requests.length, 2);
});

test('运行中的任务不会被调度重复触发；无间隔的任务不参与调度', async (t) => {
  let clock = 3_000_000;
  const { runner, app, requests, block, release } = setup(t, () => clock);
  block();
  const task = runner.create({ name: '挂起中的任务', prompt: '做点什么', workspace: process.cwd() });
  runner.setSchedule(task.id, { intervalMinutes: 5, nextRunAt: clock - 1, paused: false });
  const execution = runner.execute(app, task.id);
  await waitRunning(runner, task.id);
  assert.equal(requests.length, 1, '执行自身的请求已发出');
  await runner.tick(app);
  assert.equal(requests.length, 1, '运行中不重复触发');
  runner.stop(task.id);
  release();
  await waitDone(runner, task.id);

  const plain = runner.create({ name: '一次性任务', prompt: '只跑一次', workspace: process.cwd() });
  const plainExecution = runner.execute(app, plain.id);
  await waitDone(runner, plain.id);
  await plainExecution;
  assert.equal(runner.get(plain.id)!.nextRunAt, undefined, '无间隔任务不进入调度');
});

test('execute 公共入口拒绝并发执行另一任务且不修改其会话记录', async (t) => {
  const { runner, app, requests, block, release, workspace } = setup(t, () => 3_100_000);
  const first = runner.create({ name: '正在执行', prompt: '慢慢做', workspace });
  const other = runner.create({ name: '等待执行', prompt: '稍后做', workspace });
  const before = runner.get(other.id);
  block();
  const execution = runner.execute(app, first.id);
  let attempted = Promise.resolve();
  try {
    await waitRunning(runner, first.id);
    assert.equal(requests.length, 1, '第一任务的模型请求确实挂起');
    attempted = runner.execute(app, other.id);
    assert.equal(runner.isRunning(other.id), false, '第二任务不能进入模型等待，避免等待拒绝时死锁');
    await assert.rejects(attempted, /自动化任务.*运行/);
    assert.deepEqual(runner.get(other.id), before, '拒绝不能新建会话或改写任务');
    assert.equal(requests.length, 1);
  } finally { release(); await Promise.allSettled([execution, attempted]); }
  await runner.execute(app, other.id);
  assert.equal(runner.get(other.id)!.status, 'completed');
  assert.equal(requests.length, 2, '前一任务结束后仍可执行');
});

test('自动化任务以任务工作目录为工具基准：文件写入任务目录，结束后恢复主会话基准', async (t) => {
  let clock = 4_000_000;
  const { runner, app, dir } = setup(t, () => clock);
  const taskWorkspace = path.join(dir, 'auto-ws');
  mkdirSync(taskWorkspace, { recursive: true });
  const previousCwd = process.cwd();
  const task = runner.create({ name: '写文件任务', prompt: '把 hello 写入 out/hello.txt', workspace: taskWorkspace });
  runner.setSchedule(task.id, { intervalMinutes: 10, nextRunAt: clock - 1, paused: false });
  await runner.tick(app);
  await waitDone(runner, task.id);
  assert.equal(existsSync(path.join(taskWorkspace, 'out', 'hello.txt')), true, '文件写入任务工作目录');
  assert.equal(process.cwd(), previousCwd, '执行后恢复主会话基准');
  assert.equal(existsSync(path.join(previousCwd, 'out')), false, '不能写进主会话目录');
});

test('自动化执行期间主会话的路径基准不被任务工作目录干扰', async (t) => {
  const { runner, app, block, release, dir } = setup(t, () => 5_000_000);
  const taskWorkspace = path.join(dir, 'auto-ws');
  mkdirSync(taskWorkspace, { recursive: true });
  const mainCwd = process.cwd();
  const task = runner.create({ name: '阻塞任务', prompt: '慢慢写入', workspace: taskWorkspace });
  runner.setSchedule(task.id, { intervalMinutes: 10, nextRunAt: 5_000_000 - 1, paused: false });
  block();
  const execution = runner.tick(app);
  await waitRunning(runner, task.id);
  // 并发隔离目标：自动化挂起期间，主会话的相对路径解析应落在主基准
  assert.equal(resolvePath('probe.txt').abs, path.join(mainCwd, 'probe.txt'), '主会话路径基准不受自动化任务干扰');
  release();
  await waitDone(runner, task.id);
  await execution;
});

test('worktree 任务：在独立 git worktree 中执行，主工作区不受影响，分支保留供审查', async (t) => {
  const { runner, app, workspace, dir } = setup(t, () => 6_000_000);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace });
  git('init');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'init');

  const task = runner.create({ name: 'worktree 任务', prompt: '把 hello 写入 wt-output.txt', workspace, worktree: true });
  runner.setSchedule(task.id, { intervalMinutes: 10, nextRunAt: 6_000_000 - 1, paused: false });
  await runner.tick(app);
  await waitDone(runner, task.id);

  const done = runner.get(task.id)!;
  assert.equal(done.status, 'completed');
  assert.ok(done.sessionId, 'worktree 准备不能覆盖本轮会话标识');
  const wtPath = done.worktreePath!;
  assert.ok(wtPath && wtPath.includes('worktree'), '任务记录 worktree 路径');
  assert.equal(existsSync(path.join(wtPath, 'out', 'hello.txt')), true, '文件写入 worktree 而非主工作区');
  assert.equal(existsSync(path.join(workspace, 'out')), false, '主工作区不受影响');
  const branches = execFileSync('git', ['branch', '--list', 'tcode-*'], { cwd: workspace }).toString();
  assert.match(branches, /tcode-/, '任务分支保留供审查');
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: workspace }).toString();
  assert.match(worktrees, /tcode-/, 'worktree 保留供审查');
});

test('非 git 目录的 worktree 准备失败释放运行状态，修复工作区后可执行另一任务', async (t) => {
  const { runner, app, workspace, requests } = setup(t, () => 7_000_000);
  const task = runner.create({ name: '无 git', prompt: '做点什么', workspace, worktree: true });
  runner.setSchedule(task.id, { intervalMinutes: 10, nextRunAt: 7_000_000 - 1, paused: false });
  await runner.tick(app);
  const done = await waitDone(runner, task.id);
  assert.equal(done.status, 'error');
  assert.match(done.error ?? '', /worktree|git/i, '错误说明 worktree 创建失败原因');
  assert.equal(runner.isRunning(task.id), false, '准备失败须释放该任务的运行状态');
  assert.equal(runner.anyRunning(), false, '准备失败不能继续占用后台执行入口');
  assert.equal(requests.length, 0, '准备失败不能调用模型');

  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace });
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  const next = runner.create({ name: '恢复后的任务', prompt: '做点检查', workspace, worktree: true });
  await runner.execute(app, next.id);
  assert.equal(runner.get(next.id)!.status, 'completed', '失败后另一个任务仍可执行');
  assert.equal(requests.length, 1);
  assert.equal(runner.anyRunning(), false);
});

test('worktree 重试准备成功后保留本轮 running、sessionId 与已清空的错误', async (t) => {
  const { runner, app, workspace, dir, requests, block, release } = setup(t, () => 7_100_000);
  const task = runner.create({ name: '准备后重试', prompt: '做点检查', workspace, worktree: true });
  await runner.execute(app, task.id);
  const failed = runner.get(task.id)!;
  assert.equal(failed.status, 'error');
  assert.ok(failed.error);
  assert.ok(failed.sessionId, '首次尝试已创建会话');

  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace });
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  // 重启 runner 后重试错误任务，不借助内部字段清除旧运行状态。
  const restarted = new AutomationRunner(dir, () => 7_100_000);
  block();
  const execution = restarted.execute(app, task.id);
  let activeSessionId: string | undefined;
  try {
    await waitRunning(restarted, task.id);
    assert.equal(requests.length, 1, '模型已经调用且仍被屏障阻塞');
    const running = restarted.get(task.id)!;
    assert.equal(running.status, 'running', 'worktree 准备不能恢复旧 error 状态');
    assert.equal(running.error, undefined, '本轮必须清空上轮错误');
    assert.ok(running.sessionId, 'worktree 准备不能覆盖本轮会话标识');
    assert.notEqual(running.sessionId, failed.sessionId, '重试使用新会话，不能恢复上轮 sessionId');
    activeSessionId = running.sessionId;
    assert.ok(existsSync(path.join(dir, 'automations', task.id, 'sessions', activeSessionId)), '会话标识指向真实会话文件');
    assert.ok(running.worktreePath && existsSync(running.worktreePath), '真实 worktree 已创建');
  } finally {
    release();
    await execution;
  }
  const done = restarted.get(task.id)!;
  assert.equal(done.status, 'completed');
  assert.equal(done.error, undefined);
  assert.equal(done.sessionId, activeSessionId, '终态仍归属本轮会话');
  assert.equal(restarted.anyRunning(), false);
});

test('tick 在前一任务挂起后重读排队任务，不恢复已删除任务或覆盖暂停', async (t) => {
  for (const action of ['delete', 'pause'] as const) await t.test(action, async (t) => {
    let clock = 7_200_000;
    const { runner, app, workspace, requests, block, release } = setup(t, () => clock);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace });
    git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
    writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
    git('add', '.'); git('commit', '-m', 'init');
    const queued = runner.create({ name: '排队 B', prompt: '检查 B', workspace });
    runner.setSchedule(queued.id, { intervalMinutes: 10, nextRunAt: clock - 1, paused: false });
    clock++;
    const first = runner.create({ name: '阻塞 A', prompt: '检查 A', workspace });
    runner.setSchedule(first.id, { intervalMinutes: 10, nextRunAt: clock - 1, paused: false });
    assert.equal(runner.list()[0]!.id, first.id, 'A 按创建时间排在 B 前面');
    block();
    const execution = runner.tick(app);
    try {
      await waitRunning(runner, first.id);
      assert.equal(requests.length, 1, 'A 已调用模型且仍挂起');
      assert.equal(runner.isRunning(queued.id), false, 'B 尚未执行');
      if (action === 'delete') assert.equal(runner.remove(queued.id), 'removed');
      else runner.setSchedule(queued.id, { paused: true });
    } finally {
      release();
      await execution;
    }
    if (action === 'delete') assert.equal(runner.get(queued.id), undefined, '旧 due 快照不能复活已删除的 B');
    else assert.equal(runner.get(queued.id)!.paused, true, '旧 due 快照不能覆盖 B 的暂停设置');
    assert.equal(requests.length, 1, 'B 不应发起模型请求');
    assert.equal(runner.get(first.id)!.status, 'completed');
    assert.equal(runner.anyRunning(), false);
  });
});

test('worktree 清理：丢弃模式移除 worktree 与分支并清空任务记录', async (t) => {
  const { runner, app, workspace, dir } = setup(t, () => 8_000_000);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace });
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');

  const task = runner.create({ name: '清理目标', prompt: '写入 discard-me.txt', workspace, worktree: true });
  runner.setSchedule(task.id, { intervalMinutes: 10, nextRunAt: 8_000_000 - 1, paused: false });
  await runner.tick(app);
  const done = await waitDone(runner, task.id);
  const wtPath = done.worktreePath!;
  const branch = `tcode-${task.id.slice(0, 8)}`;
  assert.equal(existsSync(path.join(wtPath, 'out', 'hello.txt')), true, '前置：任务已在 worktree 写文件');

  const removed = await runner.removeWorktree(task.id, 'discard');
  assert.equal(removed, 'removed');
  assert.equal(existsSync(wtPath), false, 'worktree 目录已移除');
  const branches = execFileSync('git', ['branch', '--list', branch], { cwd: workspace }).toString();
  assert.equal(branches.trim(), '', '分支已删除');
  assert.equal(runner.get(task.id)!.worktreePath, undefined, '任务记录已清空引用');
  assert.equal(await runner.removeWorktree(task.id, 'discard'), 'missing', '重复清理返回 missing');
});

test('worktree 清理 merged 模式要求分支已合并，未合并报错可见', async (t) => {
  const { runner, app, workspace } = setup(t, () => 9_000_000);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace });
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');

  const task = runner.create({ name: '合并目标', prompt: '写入点什么', workspace, worktree: true });
  runner.setSchedule(task.id, { intervalMinutes: 10, nextRunAt: 9_000_000 - 1, paused: false });
  await runner.tick(app);
  await waitDone(runner, task.id);
  const branch = `tcode-${task.id.slice(0, 8)}`;
  const wtPath = runner.get(task.id)!.worktreePath!;
  // 模拟模型在 worktree 提交：分支领先主分支一 commit（未合并）
  git('-C', wtPath, 'add', '.'); git('-C', wtPath, 'commit', '-m', 'task work');
  assert.equal(runner.removeWorktree(task.id, 'merged'), 'not-merged', '未合并分支拒绝安全删除');
  assert.equal(existsSync(wtPath), true, '未合并时 worktree 目录保留');
  assert.match(runner.get(task.id)!.worktreePath ?? '', /worktree/, '任务记录保留 worktree 路径');
  // 模拟用户已合并分支到主分支：merge 后 -d 通过
  git('merge', branch);
  assert.equal(runner.removeWorktree(task.id, 'merged'), 'removed');
  assert.equal(runner.get(task.id)!.worktreePath, undefined);
});

test('运行中的任务拒绝清理 worktree', async (t) => {
  const { runner, app, block, release, workspace, requests } = setup(t, () => 10_000_000);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace });
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(workspace, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'init');
  block();
  const task = runner.create({ name: '运行中清理', prompt: '慢慢做', workspace, worktree: true });
  runner.setSchedule(task.id, { intervalMinutes: 10, nextRunAt: 10_000_000 - 1, paused: false });
  // tick 会 await execute；provider 被 block 时不能 await tick，否则死锁
  const execution = runner.tick(app);
  try {
    await waitRunning(runner, task.id);
    assert.equal(requests.length, 1, '模型已实际调用且仍被阻塞，不能只检查 running 标记');
    const worktreePath = runner.get(task.id)!.worktreePath!;
    assert.ok(existsSync(worktreePath), '运行中 worktree 真实存在');
    assert.equal(runner.removeWorktree(task.id, 'discard'), 'running');
    assert.ok(existsSync(worktreePath), '拒绝清理后目录仍保留');
  } finally {
    runner.stop(task.id);
    release();
    await execution;
  }
});
