// 定时调度单测：注入时钟 + 假 provider，进程内验证 nextRunAt 推进、到期触发、暂停冻结。
// HTTP/CLI 全链路回归在 web-automation.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutomationRunner, type AutomationTask } from '../src/core/automation.ts';
import { SessionStore } from '../src/core/session.ts';
import writePlugin from '../src/plugins/tools/write.ts';
import { buildSystemPrompt } from '../src/core/systemprompt.ts';
import type { App } from '../src/kernel/app.ts';

function setup(t: TestContext, now: () => number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-auto-sched-'));
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
    runner, app, requests, dir,
    block: () => { blocked = new Promise((resolve) => { releaseBlocked = resolve; }); },
    release: () => releaseBlocked(),
  };
}

const waitRunning = async (runner: AutomationRunner, id: string) => {
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
