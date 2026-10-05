// 工作台 Git 审查：逐文件变更、暂存、提交与基于写前快照的选择性撤销。
// 不调用 shell，不运行外部 diff/textconv；除暂存/提交/撤销外不改任何文件或索引。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256, type FileWriteEntry } from '../plugins/tools/filejournal.ts';

const exec = promisify(execFile);
const LIMIT = 2 * 1024 * 1024;
const MAX_FILES = 200;

export interface ChangeFile {
  /** 相对仓库根的路径 */
  path: string;
  staged: boolean;
  untracked: boolean;
  deleted: boolean;
  /** 本轮有写前快照，可一键撤销 */
  revertable: boolean;
  diff: string | null;
}

export interface ChangesResult {
  files: ChangeFile[];
  truncated?: boolean;
  error?: string;
  journalError?: string;
}

type StatusEntry = { xy: string; path: string; orig?: string };

async function git(cwd: string, args: string[], opts: { allowExit1?: boolean; timeout?: number } = {}): Promise<string> {
  try {
    const result = await exec('git', ['-c', 'core.quotepath=false', ...args], {
      cwd, encoding: 'utf8', maxBuffer: LIMIT, timeout: opts.timeout ?? 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
    });
    return result.stdout;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (opts.allowExit1 && failure.code === 1) return failure.stdout ?? '';
    throw error;
  }
}

function parseStatus(output: string): StatusEntry[] {
  const fields = output.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const xy = field.slice(0, 2);
    const filePath = field.slice(3);
    if (xy.includes('R') || xy.includes('C')) entries.push({ xy, path: filePath, orig: fields[++i] });
    else entries.push({ xy, path: filePath });
  }
  return entries;
}

async function fileDiff(cwd: string, entry: StatusEntry, hasHead: boolean): Promise<string> {
  const options = ['--no-ext-diff', '--no-textconv', '--color=never'];
  if (entry.xy === '??') {
    const absolute = path.resolve(cwd, entry.path);
    return git(cwd, ['diff', ...options, '--no-index', '--', '/dev/null', absolute], { allowExit1: true });
  }
  if (hasHead) return git(cwd, ['diff', ...options, 'HEAD', '--', entry.path], { allowExit1: true });
  return (await git(cwd, ['diff', ...options, '--cached', '--', entry.path])) + await git(cwd, ['diff', ...options, '--', entry.path]);
}

/** macOS 等系统的 /var 是 /private/var 的别名；快照按工作目录记录，这里两种形态都识别 */
function existingRealpath(target: string): string {
  try { return realpathSync(target); } catch { return target; }
}

/** 逐文件变更视图；journal 是本轮写前快照（绝对路径 → 条目），用于标记可撤销文件 */
export async function workspaceChanges(cwd: string, journal: Map<string, FileWriteEntry>): Promise<ChangesResult> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    const toplevel = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    const entries = parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    let hasHead = true;
    try { await git(cwd, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
    const files: ChangeFile[] = [];
    let truncated = false;
    let budget = LIMIT;
    for (const entry of entries.slice(0, MAX_FILES)) {
      const absolute = path.resolve(toplevel, entry.path);
      let diff: string | null = null;
      if (!truncated) {
        diff = await fileDiff(toplevel, entry, hasHead);
        if (diff.length > budget) { diff = null; truncated = true; }
        else budget -= diff.length;
      }
      const added = entry.xy.includes('A');
      files.push({
        path: entry.path,
        staged: entry.xy[0] !== ' ' && entry.xy[0] !== '?',
        untracked: entry.xy === '??' || added,
        deleted: entry.xy.includes('D'),
        revertable: journal.has(absolute) || journal.has(existingRealpath(absolute)),
        diff: diff && diff.trim() ? diff : null,
      });
    }
    return { files, ...(truncated || entries.length > MAX_FILES ? { truncated: true } : {}) };
  } catch {
    return { files: [], error: '无法读取 Git 变更，请确认当前项目是 Git 仓库且已安装 Git' };
  }
}

/** 暂存或取消暂存；paths 必须来自当前变更列表，防止任意路径注入 */
export async function stagePaths(cwd: string, paths: string[], stage: boolean): Promise<void> {
  const known = new Set<string>();
  for (const entry of parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))) {
    known.add(entry.path);
    if (entry.orig) known.add(entry.orig);
  }
  for (const requested of paths) {
    if (!known.has(requested)) throw new RangeError(`${requested} 不在当前变更列表中`);
  }
  let hasHead = true;
  try { await git(cwd, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
  if (stage) await git(cwd, ['add', '-A', '--', ...paths], { timeout: 15000 });
  else if (hasHead) await git(cwd, ['reset', '--quiet', 'HEAD', '--', ...paths], { timeout: 15000 });
  else await git(cwd, ['rm', '--cached', '--quiet', '--', ...paths], { timeout: 15000 });
}

export async function commitStaged(cwd: string, message: string): Promise<void> {
  const hasStaged = await git(cwd, ['diff', '--cached', '--name-only']);
  if (!hasStaged.trim()) throw new RangeError('没有已暂存的变更；先勾选要提交的文件');
  await git(cwd, ['commit', '-m', message], { timeout: 15000 });
}

export type RevertOutcome = 'done' | 'conflict';

/** 把文件恢复到本轮首次修改前的快照；当前内容与最后一次写入的指纹不一致即冲突，拒绝执行 */
export async function revertToEntry(entries: FileWriteEntry[]): Promise<RevertOutcome> {
  const first = entries[0];
  const last = entries[entries.length - 1];
  let current: string | null = null;
  let existed = true;
  try { current = await readFile(first.path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') existed = false;
    else throw error;
  }
  // 新建文件后来被手动删除：撤销无事可做，按完成处理
  if (!existed) return first.existed ? 'conflict' : 'done';
  if (current === null || sha256(current) !== last.postSha256) return 'conflict';
  if (first.existed) await writeFile(first.path, first.content ?? '', 'utf8');
  else await rm(first.path, { force: true });
  return 'done';
}
