// 自动化任务：一条本地任务的持久化定义 + 隔离会话后台执行。
// 语义（无人值守）：以免审批模式在当前项目运行完整 agent 轮，不占主会话；
// 结果、Token 用量与会话过程留存本机可回查；运行中可停止，重启后标记中断、可继续。
// 工具通过会话工作目录隔离；周期调度执行前重新读取任务，避免覆盖用户操作。
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runUserTurn } from './turn.ts';
import { SessionStore } from './session.ts';
import { buildSystemPrompt } from './systemprompt.ts';
import { runWithSessionCwd } from '../plugins/tools/pathguard.ts';
import type { App } from '../kernel/app.ts';
import type { ChatMessage } from '../kernel/types.ts';

export type AutomationStatus = 'running' | 'completed' | 'stopped' | 'error' | 'interrupted';

export interface AutomationTask {
  id: string;
  name: string;
  workspace: string;
  prompt: string;
  status: AutomationStatus;
  sessionId?: string;
  createdAt: number;
  finishedAt?: number;
  resultText?: string;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** worktree 任务：在主工作区的独立 git worktree（分支 tcode-<id 前 8 位>）中执行 */
  worktree?: boolean;
  worktreePath?: string;
  /** 清理已开始但资源尚未全部移除；重启后仍可重试，不能重新执行 */
  worktreeCleanupPending?: boolean;
  /** 重复执行间隔（分钟）；缺省为一次性任务 */
  intervalMinutes?: number;
  /** 下次调度触发时间（epoch ms）；仅周期任务有 */
  nextRunAt?: number;
  /** 暂停调度：到期不执行、nextRunAt 持续顺延 */
  paused?: boolean;
}

interface RunningState {
  task: AutomationTask;
  controller: AbortController | null;
  messages: ChatMessage[];
}

export class AutomationRunner {
  // Node 类型剥离不支持构造函数参数属性，字段必须显式声明（同 openai.ts）
  private readonly tcodeDir: string;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly running = new Map<string, RunningState>();
  private readonly finishedCallbacks = new Map<string, (task: AutomationTask) => void>();

  constructor(tcodeDir: string, now: () => number = () => Date.now()) {
    this.now = now;
    this.tcodeDir = tcodeDir;
    this.dir = path.join(tcodeDir, 'automations');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // 上个进程留下的运行中任务：进程已不在，标记中断等待用户继续
    for (const file of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      if (!file.endsWith('.json')) continue;
      try {
        const task = JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as AutomationTask;
        if (task.status === 'running') this.save({ ...task, status: 'interrupted' });
      } catch { /* 单个任务文件损坏不阻塞其余任务 */ }
    }
  }

  list(): AutomationTask[] {
    return readdirSync(this.dir).filter((file) => file.endsWith('.json')).map((file) => {
      try { return JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as AutomationTask; }
      catch { return { id: file, name: file, workspace: '', prompt: '', status: 'error' as const, error: '任务记录损坏', createdAt: 0 }; }
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): AutomationTask | undefined {
    return this.list().find((task) => task.id === id);
  }

  /** 是否有任务正在执行（全局单值基准下与主会话轮次互斥） */
  anyRunning(): boolean {
    return this.running.size > 0;
  }

  create(input: { name: string; prompt: string; workspace: string; intervalMinutes?: number; worktree?: boolean }): AutomationTask {
    const task: AutomationTask = {
      id: randomUUID(), name: input.name, workspace: input.workspace, prompt: input.prompt,
      status: 'running', createdAt: this.now(), ...(input.intervalMinutes ? { intervalMinutes: input.intervalMinutes } : {}),
      ...(input.worktree ? { worktree: true } : {}),
    };
    this.save(task);
    return task;
  }

  /** 调度字段更新（间隔 / 下次触发 / 暂停）；字段缺省保持不变 */
  setSchedule(id: string, patch: { intervalMinutes?: number; nextRunAt?: number; paused?: boolean }): AutomationTask {
    const task = this.get(id);
    if (!task) throw new Error('没有这个自动化任务');
    if (task.worktreeCleanupPending && patch.paused === false) throw new Error('请先完成 worktree 清理');
    const next: AutomationTask = { ...task };
    if (patch.intervalMinutes !== undefined) next.intervalMinutes = patch.intervalMinutes;
    if (patch.nextRunAt !== undefined) next.nextRunAt = patch.nextRunAt;
    if (patch.paused !== undefined) next.paused = patch.paused;
    this.save(next);
    return next;
  }

  /** 调度推进：到期且未暂停的周期任务后台执行；暂停任务冻结并顺延 nextRunAt */
  async tick(app: App): Promise<void> {
    if (this.anyRunning()) return;
    const ids = this.list().map((task) => task.id);
    for (const id of ids) {
      if (this.anyRunning()) return;
      // 上一任务执行期间，用户可能删除、暂停、清理或改期，不能写回旧快照。
      const task = this.get(id);
      if (!task?.intervalMinutes || task.worktreeCleanupPending) continue;
      if ((task.nextRunAt ?? 0) > this.now()) continue;
      if (task.paused) {
        this.save({ ...task, nextRunAt: this.now() + task.intervalMinutes * 60_000 });
        continue;
      }
      // 先推进再执行，避免执行期间被再次调度
      this.save({ ...task, nextRunAt: this.now() + task.intervalMinutes * 60_000 });
      await this.execute(app, task.id).catch(() => {});
    }
  }

  stop(id: string): boolean {
    const state = this.running.get(id);
    if (!state) return false;
    state.controller?.abort();
    return true;
  }

  /** 后台执行；调用方自行捕获异常。continueTask=在同一会话上下文里追加继续指令；onFinished=终态回调（供通知）。 */
  async execute(app: App, id: string, options: { continueTask?: boolean; onFinished?: (task: AutomationTask) => void } = {}): Promise<void> {
    const continueTask = options.continueTask === true;
    const onFinished = options.onFinished;
    let task = this.get(id);
    if (!task || this.running.has(id)) return;
    if (this.anyRunning()) throw new Error('已有自动化任务正在运行，请等待完成或先停止');
    if (task.worktreeCleanupPending) throw new Error('请先完成 worktree 清理');
    const store = new SessionStore(path.join(this.dir, id, 'sessions'));
    store.start(); // 生成任务会话文件；本轮消息由 runUserTurn 落盘，供回查
    const controller = new AbortController();
    const messages: ChatMessage[] = [];
    if (continueTask && task.sessionId) {
      try {
        const history = store.history(task.sessionId, task.workspace);
        messages.push(...history.messages.filter((message) => message.role !== 'system'));
      } catch { /* 历史缺失则从系统提示重新开始 */ }
    }
    if (!messages.length) messages.push({ role: 'system', content: '' }); // 准备工作目录后填入系统提示
    messages.push({ role: 'user', content: continueTask ? '继续完成该任务；若无法继续，说明已完成的阶段与阻碍。' : task.prompt });
    this.running.set(id, { task, controller, messages });
    if (onFinished) this.finishedCallbacks.set(id, onFinished);
    let promptTokens = 0, completionTokens = 0;
    const executeTurn = async () => {
      try {
        await runUserTurn({ ...app, store, messages, yolo: { value: true }, planMode: { value: false } } as App,
          messages.at(-1)!.content ?? '', {
          check: async () => true, // 无人值守：自动化任务以免审批模式运行（创建时明示）
          signal: controller.signal,
          emit: (ev) => {
            if (ev.type === 'usage') { promptTokens += ev.prompt_tokens; completionTokens += ev.completion_tokens; }
          },
        });
        const resultText = [...messages].reverse().find((message) => message.role === 'assistant')?.content ?? '';
        this.finish(id, { status: resultText ? 'completed' : 'error', resultText: resultText || undefined, error: resultText ? undefined : '模型未返回文本', promptTokens, completionTokens });
      } catch (error) {
        const aborted = controller.signal.aborted || (error as Error).name === 'AbortError';
        this.finish(id, aborted
          ? { status: 'stopped', error: '已停止' }
          : { status: 'error', error: (error as Error).message });
      }
    };
    // worktree 任务：在主工作区的独立 git worktree（分支 tcode-<id 前 8 位>）中执行，
    // 文件改动隔离在分支上，结束保留 worktree 供审查/合并；主工作区不受影响
    try {
      task = { ...task, status: 'running', sessionId: store.currentId ?? task.sessionId, finishedAt: undefined, resultText: undefined, error: undefined };
      this.save(task);
      let runDir = task.workspace;
      if (task.worktree || task.worktreePath) {
        try {
          const state = this.worktreeState(task);
          if (state.registered) {
            if (!existsSync(state.path)) throw new Error('worktree 目录缺失，请先清理剩余资源');
            task = { ...task, worktreePath: state.path };
            this.save(task);
          } else {
            if (state.branchExists) throw new Error('任务分支仍存在，请先清理剩余资源');
            task = { ...task, worktreePath: state.path };
            // 在 Git 创建前记录固定位置，失败或进程退出后仍能找到部分创建的资源。
            this.save(task);
            try {
              this.git(task.workspace, ['worktree', 'add', '--no-track', state.path, '-b', `tcode-${id.slice(0, 8)}`]);
            } catch (error) {
              const leftover = this.worktreeState(task);
              task = { ...task, worktreePath: leftover.registered ? state.path : undefined,
                worktreeCleanupPending: leftover.registered || leftover.branchExists || undefined };
              this.save(task);
              throw error;
            }
          }
          runDir = state.path;
        } catch (error) {
          this.finish(id, { status: 'error', error: `worktree 准备失败（工作区须为 git 仓库）：${(error as Error).message}` });
          return;
        }
      }
      if (messages[0]?.role === 'system') messages[0].content = buildSystemPrompt(runDir, undefined, this.tcodeDir);
      await runWithSessionCwd(runDir, executeTurn);
    } finally {
      this.running.delete(id);
      this.finishedCallbacks.delete(id);
    }
  }

  /** 删除已结束的任务记录与会话；运行中或仍保留 worktree 时拒绝。 */
  remove(id: string): 'removed' | 'running' | 'missing' | 'worktree' {
    if (this.running.has(id)) return 'running';
    const task = this.get(id);
    if (!task) return 'missing';
    if (path.basename(id) !== id || id === '.' || id === '..') throw new Error('任务标识损坏，拒绝删除');
    if (task?.worktreePath || task?.worktreeCleanupPending) return 'worktree';
    if (existsSync(path.join(this.dir, id, 'worktree'))) return 'worktree';
    const file = path.join(this.dir, id + '.json');
    if (!existsSync(file)) return 'missing';
    unlinkSync(file);
    rmSync(path.join(this.dir, id), { recursive: true, force: true });
    return 'removed';
  }

  /** 清理 worktree：discard 强删分支（丢弃改动），merged 用 -d 安全删除（须已合并）；返回任务当前引用 */
  removeWorktree(id: string, mode: 'discard' | 'merged'): 'removed' | 'running' | 'missing' | 'not-merged' {
    if (this.running.has(id)) return 'running';
    const task = this.get(id);
    if (!task || (!task.worktree && !task.worktreePath && !task.worktreeCleanupPending)) return 'missing';
    const branch = `tcode-${id.slice(0, 8)}`;
    const state = this.worktreeState(task);
    if (!state.registered && !state.branchExists && !task.worktreePath && !task.worktreeCleanupPending) return 'missing';
    if (mode === 'merged' && state.registered && !state.branchExists) throw new Error('任务分支引用缺失，已保留 worktree；请修复引用或显式丢弃');
    // merged 先固化产出再检查；discard 是显式丢弃，不依赖提交成功。
    if (mode === 'merged' && state.registered) try {
      const statusArgs = ['-C', state.path, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'];
      const status = this.git(task.workspace, statusArgs);
      if (status.split('\n').some((line) => line.startsWith('!! '))) throw new Error('worktree 含 Git 忽略的文件；请先处理这些文件或显式丢弃，不能自动提交或删除');
      if (status.trim()) {
        this.git(task.workspace, ['-C', state.path, 'add', '-A']);
        this.git(task.workspace, ['-C', state.path, 'commit', '-m', 'tcode: 固化任务产出']);
        // 提交 hook 可能产生新文件，不能让 clean 检查遗漏这些产出。
        if (this.git(task.workspace, statusArgs).trim()) throw new Error('提交后 worktree 仍有文件变化，请检查后重试');
      }
    } catch (error) { throw new Error(`任务产出固化失败，未清理 worktree：${(error as Error).message}`); }
    if (mode === 'merged' && state.branchExists) {
      try {
        this.git(task.workspace, ['merge-base', '--is-ancestor', branch, 'HEAD']);
        // branch -d 优先验证配置的 upstream；提前采用同一限制，避免移除后才拒绝。
        if (state.upstream) this.git(task.workspace, ['merge-base', '--is-ancestor', branch, state.upstream]);
      } catch (error) {
        if ((error as { status?: number }).status === 1) return 'not-merged';
        throw error;
      }
    }
    // 先持久化意图；每步失败均留有重试记录，重试从实际 Git 资源继续。
    let pending = { ...task, worktreeCleanupPending: true, ...(task.intervalMinutes ? { paused: true } : {}) };
    this.save(pending);
    if (state.registered) {
      try {
        this.git(task.workspace, ['-c', 'status.showUntrackedFiles=all', 'worktree', 'remove', state.path]);
      } catch (error) {
        if (mode === 'merged') throw new Error(`worktree 移除失败，请检查目录后重试：${(error as Error).message}`);
        this.git(task.workspace, ['worktree', 'remove', '--force', state.path]);
      }
    }
    pending = { ...pending, worktreePath: undefined };
    this.save(pending);
    if (state.branchExists) {
      // merged 用 -d（安全删除，须已合并）；discard 用 -D 强删（丢弃改动）
      this.git(task.workspace, ['branch', mode === 'merged' ? '-d' : '-D', branch]);
    }
    this.save({ ...pending, worktreeCleanupPending: undefined });
    return 'removed';
  }

  private git(workspace: string, args: string[]): string {
    return execFileSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** 固定位置与 Git 注册信息共同确认归属，不能仅凭 JSON 中的路径强删。 */
  private worktreeState(task: AutomationTask): { path: string; registered: boolean; branchExists: boolean; upstream: string } {
    if (path.basename(task.id) !== task.id || task.id === '.' || task.id === '..') throw new Error('任务标识损坏，拒绝清理');
    const taskDir = path.join(realpathSync(this.dir), task.id);
    const expected = path.join(taskDir, 'worktree');
    if (existsSync(taskDir) && realpathSync(taskDir) !== taskDir) throw new Error('任务目录归属不符，拒绝清理');
    if (task.worktreePath) {
      const recorded = existsSync(task.worktreePath) ? realpathSync(task.worktreePath)
        : path.join(realpathSync(path.dirname(task.worktreePath)), path.basename(task.worktreePath));
      if (recorded !== expected) throw new Error('worktree 路径归属不符，拒绝清理');
    }
    const ref = `refs/heads/tcode-${task.id.slice(0, 8)}`;
    const entries = this.git(task.workspace, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').map((entry) => {
      const fields = entry.split('\0');
      return { path: fields.find((field) => field.startsWith('worktree '))?.slice(9), branch: fields.find((field) => field.startsWith('branch '))?.slice(7) };
    });
    const entry = entries.find((item) => item.path === expected);
    if ((entry && entry.branch !== ref) || entries.some((item) => item.branch === ref && item.path !== expected)) throw new Error('worktree 分支归属不符，拒绝清理');
    if (existsSync(expected) && !entry) throw new Error('目录不在 Git worktree 注册中，拒绝清理');
    const branch = this.git(task.workspace, ['for-each-ref', '--format=%(refname) %(upstream)', ref]).trim().split('\n').find((line) => line.split(' ')[0] === ref);
    return { path: expected, registered: !!entry, branchExists: branch !== undefined, upstream: branch?.slice(ref.length + 1) ?? '' };
  }

  isRunning(id: string): boolean {
    return this.running.get(id)?.task.id === id;
  }

  private finish(id: string, patch: Partial<AutomationTask>): void {
    const task = this.get(id);
    if (!task) return;
    const next: AutomationTask = { ...task, ...patch, status: patch.status ?? task.status, finishedAt: this.now() };
    // 周期任务完成后按间隔推进下次触发；一次性任务不进入调度
    if (task.intervalMinutes) next.nextRunAt = this.now() + task.intervalMinutes * 60_000;
    this.save(next);
    this.finishedCallbacks.get(id)?.(next);
  }

  private save(task: AutomationTask): void {
    const temporary = path.join(this.dir, `.${task.id}.${randomUUID().slice(0, 8)}.tmp`);
    writeFileSync(temporary, JSON.stringify(task, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path.join(this.dir, `${task.id}.json`));
  }
}
