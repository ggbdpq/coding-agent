// 自动化任务：一条本地任务的持久化定义 + 隔离会话后台执行。
// 语义（无人值守）：以免审批模式在当前项目运行完整 agent 轮，不占主会话；
// 结果、Token 用量与会话过程留存本机可回查；运行中可停止，重启后标记中断、可继续。
// 第一片边界：仅支持当前项目（工具的路径解析依赖进程 cwd），不做定时调度。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  private readonly running = new Map<string, RunningState>();

  constructor(tcodeDir: string) {
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

  create(input: { name: string; prompt: string; workspace: string }): AutomationTask {
    const task: AutomationTask = {
      id: randomUUID(), name: input.name, workspace: input.workspace, prompt: input.prompt,
      status: 'running', createdAt: Date.now(),
    };
    this.save(task);
    return task;
  }

  stop(id: string): boolean {
    const state = this.running.get(id);
    if (!state) return false;
    state.controller?.abort();
    return true;
  }

  /** 后台执行；调用方自行捕获异常。continueTask=在同一会话上下文里追加继续指令。 */
  async execute(app: App, id: string, continueTask = false): Promise<void> {
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
    }
  }

  isRunning(id: string): boolean {
    return this.running.get(id)?.task.id === id;
  }

  private finish(id: string, patch: Partial<AutomationTask>): void {
    const task = this.get(id);
    if (!task) return;
    this.save({ ...task, ...patch, status: patch.status ?? task.status, finishedAt: Date.now() });
  }

  private save(task: AutomationTask): void {
    const temporary = path.join(this.dir, `.${task.id}.${randomUUID().slice(0, 8)}.tmp`);
    writeFileSync(temporary, JSON.stringify(task, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path.join(this.dir, `${task.id}.json`));
  }
}
