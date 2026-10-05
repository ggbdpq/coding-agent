// 会话持久化：JSONL 追加写，一行一条 JSON（meta 行 + message 行）。
// /resume 的语义 = 读旧文件、换新文件继续写——避免追加到可能损坏的旧文件。
// 目录边界：所有读写都限定在会话目录内，出目录一律拒绝/跳过。
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { ChatMessage } from '../kernel/types.ts';
import type { SessionInitialData } from '../kernel/app.ts';

export interface SessionSummary {
  file: string;
  mtime: number;
  /** 首条用户输入，用作列表标签 */
  label: string;
}

interface SessionRecord {
  type?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  restoredTurnId?: unknown;
  message?: Record<string, unknown>;
  event?: Record<string, unknown>;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export class SessionStore {
  private filePath: string | null = null;
  private sessionId: string | null = null;
  /** 归一化后的会话目录绝对路径 */
  private readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
    mkdirSync(this.root, { recursive: true });
  }

  get currentId(): string | null { return this.sessionId; }

  /** 目录边界校验：目标必须是本目录本身或本目录的直接/间接子路径 */
  private isInsideDir(target: string): boolean {
    return target === this.root || target.startsWith(this.root + path.sep);
  }

  /** 开新会话文件并写入元信息行 */
  start(meta: Record<string, unknown> = {}, initial: SessionInitialData = {}, commitWorkspace?: () => void): void {
    // Windows 文件名禁 :，把 ISO 时间的冒号一并换掉
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
      .toString(36)
      .slice(2, 6)}.jsonl`;
    const file = path.resolve(this.root, name);
    if (!this.isInsideDir(file)) throw new Error('会话文件路径越界');
    const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : name;
    const restoredTurnId = initial.activity?.findLast((event) => event.type === 'turn_start')?.id;
    const records = [{ type: 'meta', ts: Date.now(), ...meta, sessionId,
      ...(typeof restoredTurnId === 'string' ? { restoredTurnId } : {}) },
      ...(initial.messages ?? []).map((message) => ({ type: 'message', message })),
      ...(initial.activity ?? []).map((event) => ({ type: 'activity', event }))];
    const temporary = file + `.${randomBytes(8).toString('hex')}.tmp`;
    let created = false;
    let published = false;
    try {
      writeFileSync(temporary, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      created = true;
      renameSync(temporary, file);
      published = true;
      // 新日志完整发布后才提交工作目录/配置；提交失败撤销新日志，保持原活动文件。
      commitWorkspace?.();
    } catch (error) {
      if (created) { try { unlinkSync(published ? file : temporary); } catch {} }
      throw error;
    }
    this.filePath = file;
    this.sessionId = sessionId;
  }

  /** 追加一条消息；落盘失败静默（记会话是锦上添花，不该打断对话） */
  append(message: ChatMessage): void {
    if (!this.filePath) return;
    try {
      appendFileSync(this.filePath, `${JSON.stringify({ type: 'message', message })}\n`);
    } catch {
      /* 忽略 */
    }
  }

  /** 只追加快照，不重写原历史；失败让压缩保留原上下文。 */
  checkpoint(messages: ChatMessage[]): void {
    if (this.filePath) appendFileSync(this.filePath, JSON.stringify({ type: 'context_checkpoint', messages }) + '\n');
  }

  /** 最近 n 个会话（排除当前文件），按修改时间倒序 */
  listRecent(n: number): SessionSummary[] {
    const entries = readdirSync(this.root)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.resolve(this.root, f))
      .filter((file) => this.isInsideDir(file) && file !== this.filePath)
      .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, n);
    return entries.map((e) => ({ ...e, label: this.readLabel(e.file) }));
  }

  /** 读指定会话文件的全部消息行；越出会话目录的路径一律拒绝 */
  load(file: string): ChatMessage[] {
    const resolved = path.resolve(file);
    if (!this.isInsideDir(resolved)) return [];
    const messages: ChatMessage[] = [];
    for (const line of readFileSync(resolved, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { type?: string; message?: ChatMessage; messages?: ChatMessage[] };
        if (o.type === 'context_checkpoint' && Array.isArray(o.messages) && o.messages.length
          && o.messages.every((message) => message && ['system', 'user', 'assistant', 'tool'].includes(message.role))) {
          messages.splice(0, messages.length, ...o.messages);
        }
        if (o.type === 'message' && o.message) messages.push(o.message);
      } catch {
        /* 跳过坏行 */
      }
    }
    return messages;
  }

  /** 消息继续遵循旧 schema；桌面活动单独追加，其他 runtime 会忽略这些行。 */
  appendActivity(event: Record<string, unknown>): void {
    if (this.filePath) appendFileSync(this.filePath, JSON.stringify({ type: 'activity', event }) + '\n');
  }

  private records(file: string): SessionRecord[] {
    if (!this.isInsideDir(file) || lstatSync(file).isSymbolicLink()) throw new Error('会话路径无效');
    return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      try {
        const record = jsonObject(JSON.parse(line));
        return record ? [{ ...record, message: jsonObject(record.message), event: jsonObject(record.event) }] : [];
      }
      catch { return []; }
    });
  }

  /** 同一逻辑会话可有多个续写文件，侧栏只展示最后一个，恢复不改旧文件。 */
  listWorkspace(cwd?: string) {
    const titles = this.readTitles();
    const latest = new Map<string, { id: string; file: string; mtime: number; title: string; label: string; cwd: string; usage: { prompt_tokens: number; completion_tokens: number } }>();
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(this.root, name);
      let records;
      try { records = this.records(file); } catch { continue; }
      const meta = records.find((record) => record.type === 'meta');
      if (typeof meta?.cwd !== 'string' || (cwd !== undefined && meta.cwd !== cwd)) continue;
      const project = meta.cwd;
      const id = typeof meta.sessionId === 'string' ? meta.sessionId : name;
      const mtime = statSync(file).mtimeMs;
      const key = project + '\0' + id;
      const previous = latest.get(key);
      if (previous && (previous.mtime > mtime || (previous.mtime === mtime && path.basename(previous.file) >= name))) continue;
      const message = records.find((record) => record.type === 'message' && record.message?.role === 'user')?.message;
      const event = records.find((record) => record.type === 'activity' && record.event?.type === 'user')?.event;
      const label = (typeof event?.text === 'string' ? event.text : typeof message?.content === 'string' ? message.content : '').slice(0, 100);
      const usage = { prompt_tokens: 0, completion_tokens: 0 };
      for (const record of records) {
        if (record.type === 'activity' && record.event?.type === 'usage') {
          usage.prompt_tokens += Number(record.event.prompt_tokens) || 0;
          usage.completion_tokens += Number(record.event.completion_tokens) || 0;
        }
      }
      latest.set(key, { id, file, mtime, title: titles[key] || titles[id] || label || '新会话', label, cwd: project, usage });
    }
    return [...latest.values()].sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file));
  }

  /** ponytail: 本地 JSONL 顺序扫描；确有大量历史造成延迟时再加搜索索引。 */
  search(query: string) {
    const needle = query.trim().toLowerCase();
    if (!needle) return { sessions: [], truncated: false };
    const sessions = [];
    for (const session of this.listWorkspace()) {
      if (!path.isAbsolute(session.cwd)) continue;
      const texts = [session.title];
      let assistant = '';
      const flush = () => { if (assistant) texts.push(assistant); assistant = ''; };
      for (const record of this.records(session.file)) {
        if (record.type === 'message' && ['user', 'assistant'].includes(String(record.message?.role)) && typeof record.message?.content === 'string') texts.push(record.message.content);
        if (record.type !== 'activity') continue;
        if (record.event?.type === 'text' && typeof record.event.delta === 'string') assistant += record.event.delta;
        else { flush(); if (record.event?.type === 'user' && typeof record.event.text === 'string') texts.push(record.event.text); }
      }
      flush();
      const text = texts.find((text) => text.toLowerCase().includes(needle));
      if (text === undefined) continue;
      if (sessions.length === 50) return { sessions, truncated: true };
      const position = text.toLowerCase().indexOf(needle);
      sessions.push({ id: session.id, title: session.title, cwd: session.cwd, mtime: session.mtime,
        excerpt: text.slice(Math.max(0, position - 50), position + 150).replace(/\s+/g, ' ') });
    }
    return { sessions, truncated: false };
  }

  history(id: string, cwd: string) {
    const selected = this.listWorkspace(cwd).find((session) => session.id === id);
    if (!selected) throw new Error('当前项目中没有这个会话');
    const records = this.records(selected.file);
    const lastStart = records.findLastIndex((record) => record.type === 'activity' && record.event?.type === 'turn_start');
    const meta = records.find((record) => record.type === 'meta');
    return { ...selected, messages: this.load(selected.file),
      pendingTurnPersisted: lastStart >= 0 && (records.slice(lastStart + 1).some((record) => record.type === 'message' && record.message?.role === 'user')
        || (typeof meta?.restoredTurnId === 'string' && meta.restoredTurnId === records[lastStart]?.event?.id)),
      activity: records.flatMap((record) => record.type === 'activity' && record.event ? [record.event] : []),
    };
  }

  rename(id: string, cwd: string, title: string): void {
    if (!title.trim() || title.length > 100) throw new Error('标题须为 1–100 个字符');
    if (!this.listWorkspace(cwd).some((session) => session.id === id)) throw new Error('当前项目中没有这个会话');
    // ponytail: 标题是呈现元数据；一个小索引即可，不修改历史消息或增加数据库。
    const file = path.join(this.root, 'titles.json');
    writeFileSync(file + '.tmp', JSON.stringify({ ...this.readTitles(), [cwd + '\0' + id]: title.trim() }), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }

  private readTitles(): Record<string, string> {
    try {
      const record = jsonObject(JSON.parse(readFileSync(path.join(this.root, 'titles.json'), 'utf8')));
      const titles: Record<string, string> = Object.create(null);
      for (const [id, value] of Object.entries(record ?? {})) {
        if (typeof value === 'string' && value.trim() && value.length <= 100) titles[id] = value;
      }
      return titles;
    }
    catch { return Object.create(null) as Record<string, string>; }
  }

  private readLabel(file: string): string {
    if (!this.isInsideDir(file)) return '(无用户消息)';
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: string | null };
        };
        if (o.type === 'message' && o.message?.role === 'user') {
          const text = (o.message.content ?? '').trim().replace(/\s+/g, ' ');
          if (text) return text.slice(0, 60) || '(空输入)';
        }
      } catch {
        /* 跳过坏行 */
      }
    }
    return '(无用户消息)';
  }
}
