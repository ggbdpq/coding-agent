// 工作台只读 Git 视图；不调用 shell，不修改索引，也不运行外部 diff/textconv。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const LIMIT = 2 * 1024 * 1024;

export async function workspaceDiff(cwd: string): Promise<{ diff: string; error?: string }> {
  const git = async (args: string[], allowDiffExit = false): Promise<string> => {
    try {
      const result = await exec('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: LIMIT, timeout: 5000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' } });
      return result.stdout;
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      if (allowDiffExit && failure.code === 1) return failure.stdout ?? '';
      throw error;
    }
  };
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
    const options = ['--no-ext-diff', '--no-textconv', '--color=never'];
    let hasHead = true;
    try { await git(['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
    let diff = hasHead ? await git(['diff', ...options, 'HEAD', '--'])
      : await git(['diff', ...options, '--cached', '--']) + await git(['diff', ...options, '--']);
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    for (const file of untracked) {
      diff += await git(['diff', ...options, '--no-index', '--', '/dev/null', file], true);
      if (diff.length > LIMIT) return { diff: diff.slice(0, LIMIT), error: '变更较大，仅显示前 2MB；请在终端查看完整 diff' };
    }
    return { diff };
  } catch {
    return { diff: '', error: '无法读取 Git diff，请确认当前项目是 Git 仓库且已安装 Git' };
  }
}
