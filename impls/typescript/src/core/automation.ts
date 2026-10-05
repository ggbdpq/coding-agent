// 自动化任务：一条本地任务的持久化定义 + 隔离会话后台执行。
// 语义（无人值守）：以免审批模式在当前项目运行完整 agent 轮，不占主会话；
// 结果、Token 用量与会话过程留存本机可回查；运行中可停止，重启后标记中断、可继续。
// 第一片边界：仅支持当前项目（工具的路径解析依赖进程 cwd），不做定时调度。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runUserTurn } from './turn.ts';
import { SessionStore } from './session.ts';
import { buildSystemPrompt } from './systemprompt.ts';
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

  create(input: { name: string; prompt: string; workspace: string; intervalMinutes?: number }): AutomationTask {
    const task: AutomationTask = {
      id: randomUUID(), name: input.name, workspace: input.workspace, prompt: input.prompt,
      status: 'running', createdAt: this.now(), ...(input.intervalMinutes ? { intervalMinutes: input.intervalMinutes } : {}),
    };
    this.save(task);
    return task;
  }

  /** 调度字段更新（间隔 / 下次触发 / 暂停）；字段缺省保持不变 */
  setSchedule(id: string, patch: { intervalMinutes?: number; nextRunAt?: number; paused?: boolean }): AutomationTask {
    const task = this.get(id);
    if (!task) throw new Error('没有这个自动化任务');
    const next: AutomationTask = { ...task };
    if (patch.intervalMinutes !== undefined) next.intervalMinutes = patch.intervalMinutes;
    if (patch.nextRunAt !== undefined) next.nextRunAt = patch.nextRunAt;
    if (patch.paused !== undefined) next.paused = patch.paused;
    this.save(next);
    return next;
  }

  /** 调度推进：到期且未暂停的周期任务后台执行；暂停任务冻结并顺延 nextRunAt */
  async tick(app: App): Promise<void> {
    const due: AutomationTask[] = [];
    for (const task of this.list()) {
      if (!task.intervalMinutes || this.isRunning(task.id)) continue;
      if ((task.nextRunAt ?? 0) > this.now()) continue;
      if (task.paused) {
        this.save({ ...task, nextRunAt: this.now() + task.intervalMinutes * 60_000 });
        continue;
      }
      due.push(task);
    }
    for (const task of due) {
      // 先推进再执行，避免执行期间被再次调度
      this.save({ ...task, nextRunAt: this.now() + task.intervalMinutes! * 60_000 });
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
    const task = this.get(id);
    if (!task || this.running.has(id)) return;
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
    if (!messages.length) messages.push({ role: 'system', content: buildSystemPrompt(task.workspace, undefined, this.tcodeDir) });
    messages.push({ role: 'user', content: continueTask ? '继续完成该任务；若无法继续，说明已完成的阶段与阻碍。' : task.prompt });
    this.running.set(id, { task, controller, messages });
    if (onFinished) this.finishedCallbacks.set(id, onFinished);
    this.save({ ...task, status: 'running', sessionId: store.currentId ?? task.sessionId, resultText: undefined, error: undefined });
    let promptTokens = 0, completionTokens = 0;
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
    } finally {
      this.running.delete(id);
      this.finishedCallbacks.delete(id);
    }
  }

  /** 删除已结束的任务：任务记录与会话目录一并清理；运行中返回 'running' */
  remove(id: string): 'removed' | 'running' | 'missing' {
    if (this.running.has(id)) return 'running';
    const file = path.join(this.dir, id + '.json');
    if (!existsSync(file)) return 'missing';
    unlinkSync(file);
    rmSync(path.join(this.dir, id), { recursive: true, force: true });
    return 'removed';
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
