// 路径守卫：解析模型给的路径，并标注目标是否越出当前工作目录。
// tcode 的安全边界是权限确认（人工把关），本模块的职责是把越界目标
// 显式带出来，让确认界面能看到 "../" 或绝对路径这类穿越意图，而不是静默放行。
// 非插件，是工具共享的工具函数。
// 会话工作目录注入：setSessionCwd 设置主会话基准；runWithSessionCwd 在指定
// 工作目录的异步上下文中执行（主会话与自动化任务各自持有基准、互不覆盖，
// 为多会话并行铺路）；两者都未生效时回落进程 cwd，既有行为不变。
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, realpathSync } from 'node:fs';

export interface ResolvedPath {
  abs: string;
  /** true = 目标在当前工作目录之外，写类操作确认时会醒目提示 */
  outside: boolean;
}

const sessionStorage = new AsyncLocalStorage<string>();
let mainCwd: string | null = null;

/** 设置主会话基准（web 壳在启动与项目切换时调用） */
export function setSessionCwd(cwd: string | null): void {
  mainCwd = cwd ? path.resolve(cwd) : null;
}

/** 在指定工作目录的异步上下文中执行 fn：链内所有路径解析与命令执行使用该目录 */
export function runWithSessionCwd<T>(cwd: string, fn: () => T): T {
  return sessionStorage.run(path.resolve(cwd), fn);
}

export function baseCwd(): string {
  return sessionStorage.getStore() ?? mainCwd ?? process.cwd();
}

export function resolvePath(input: string): ResolvedPath {
  const base = baseCwd();
  const abs = path.resolve(base, input);
  const rel = path.relative(base, abs);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  return { abs, outside };
}

/** 新文件取最近存在的祖先真实路径；已存在的符号链接必须能解析，否则交给人工审批。 */
function realDestination(input: string): string {
  let ancestor = path.resolve(baseCwd(), input);
  const suffix: string[] = [];
  while (true) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  return path.join(realpathSync(ancestor), ...suffix);
}

/** write/edit 共用真实落点白名单，避免受信目录内的符号链接把免审批写入带到外部。 */
export function isWriteTrusted(input: string, directories: readonly string[]): boolean {
  let target: string;
  try { target = realDestination(input); } catch { return false; }
  return directories.some((directory) => {
    try {
      const root = realDestination(directory);
      return target === root || target.startsWith(root + path.sep);
    } catch { return false; }
  });
}
