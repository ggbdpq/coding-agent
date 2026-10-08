// 写前快照日志：edit/write/apply_patch 读取写前原文，写入成功后记录，供工作台"撤销本轮修改"。
// sink 由 web 壳安装（模块级单例，与 pathguard 同风格）；REPL 等壳不安装则整体无操作。
// 边界：bash 等任意命令的写入无法归因，不在快照范围；超过大小上限的原文跳过快照（该文件本轮不可撤销）。
// 日志按会话存放在数据目录 file-journal/ 下，每轮开始时清空，服务重启后仍可撤销上一轮。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface FileWriteEntry {
  /** 写入时固化的真实绝对路径，避免软链重指后把快照恢复到另一个文件 */
  path: string;
  /** 写前是否存在（false = 本轮新建，撤销即删除） */
  existed: boolean;
  /** 写前内容；仅 existed=true 时有意义 */
  content: string | null;
  /** 写后内容指纹，撤销前用于冲突检测 */
  postSha256: string;
  ts: number;
}

export interface FileJournalSink {
  append(entry: FileWriteEntry): void;
}

const MAX_SNAPSHOT_BYTES = 1024 * 1024;

let sink: FileJournalSink | null = null;
let lastError: string | null = null;

export function setFileJournalSink(next: FileJournalSink | null): void {
  sink = next;
  lastError = null;
}

/** 最近一次记录失败的原因；正常为 null。读取方用于在界面上提示"快照可能不完整"。 */
export function journalError(): string | null {
  return lastError;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 已有原文构造写前快照；原文缺失或超过上限返回 null（该文件本轮不记录） */
export function preSnapshot(existed: boolean, content: string | null): { existed: boolean; content: string | null } | null {
  if (!existed) return { existed: false, content: null };
  if (content === null || Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) return null;
  return { existed: true, content };
}

/** 写前读取目标原文；无 sink 时返回 null 不做任何 IO */
export async function readPreSnapshot(abs: string): Promise<{ existed: boolean; content: string | null } | null> {
  if (!sink) return null;
  try {
    return preSnapshot(true, await readFile(abs, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false, content: null };
    return null;
  }
}

/** 写后调用：快照写入会话日志；失败只记 lastError，不影响工具结果 */
export function recordWrite(abs: string, pre: { existed: boolean; content: string | null } | null, post: string): void {
  if (!sink || !pre) return;
  try {
    sink.append({ path: realpathSync(abs), existed: pre.existed, content: pre.content, postSha256: sha256(post), ts: Date.now() });
  } catch (error) {
    lastError = `本轮修改快照记录失败，撤销可能不可用：${(error as Error).message}`;
  }
}

function journalFileFor(tcodeDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^\w.-]/g, '_');
  return path.join(tcodeDir, 'file-journal', `${safe}.json`);
}

/** 读取会话的快照日志；文件缺失视为空轮次 */
export function loadJournal(tcodeDir: string, sessionId: string): FileWriteEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(journalFileFor(tcodeDir, sessionId), 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as FileWriteEntry[]) : [];
  } catch {
    return [];
  }
}

/** 一轮开始时清空该会话的快照日志 */
export function resetJournal(tcodeDir: string, sessionId: string): void {
  try {
    saveJournal(tcodeDir, sessionId, []);
  } catch (error) {
    lastError = `本轮修改快照初始化失败，撤销可能不可用：${(error as Error).message}`;
  }
}

export function appendJournal(tcodeDir: string, sessionId: string, entry: FileWriteEntry): void {
  saveJournal(tcodeDir, sessionId, [...loadJournal(tcodeDir, sessionId), entry]);
}

/** 整体替换会话快照日志（撤销成功后剔除已消费条目） */
export function saveJournal(tcodeDir: string, sessionId: string, entries: FileWriteEntry[]): void {
  const file = journalFileFor(tcodeDir, sessionId);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
}
