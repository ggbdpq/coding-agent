// 插件内核：四类插件的类型与 definePlugin。
// 设计决策（2026-09-17，见 docs/notes/）：统一接口 + kind 判别；
// 内核只有类型与装配、没有任何行为——"特权核心"最小化，对齐 dsh 的
// "没有需要打补丁的特权核心"思想，但实现保持零依赖手写。
import type { App } from './app.ts';
import type { Config } from './config.ts';
import type { ChatClient } from './types.ts';

/** 工具插件：一个文件一个工具， ToolDef 是它的别名（core/agentloop 消费） */
export interface ToolPlugin {
  name: string;
  kind: 'tool';
  description: string;
  /** JSON Schema，直传 function calling */
  parameters: Record<string, unknown>;
  /** 写类需要逐次确认，读类免确认 */
  needsPermission: boolean;
  /** 权限确认时展示给用户看的内容 */
  preview: (args: Record<string, unknown>) => string;
  /**
   * 白名单免确认（蓝图 R4）：needsPermission 的工具可声明"此参数组合已被配置信任"
   * （如写路径落在 config.allowWriteDirs 内）。返回 true 则跳过逐次确认。
   */
  skipPermission?: (args: Record<string, unknown>, app: App) => boolean;
  /** signal：轮中用户中止时传入（bash/web_fetch 等长任务应尽快终止） */
  run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}

export type ToolDef = ToolPlugin;

/** 协议插件：matches 按注册顺序首个命中的生效，兜底放清单最后 */
export interface ProviderPlugin {
  name: string;
  kind: 'provider';
  matches: (baseUrl: string) => boolean;
  create: (config: Config) => ChatClient;
}

export interface CommandOutcome {
  exit?: boolean;
}

/** 斜杠命令插件：name 不含斜杠；输出自己 console.log，返回 exit 信号控制壳。
 * 动词用 run 而非 exec——命令只是函数调用，不碰 shell。 */
export interface CommandPlugin {
  name: string;
  kind: 'command';
  usage: string;
  summary: string;
  run: (app: App, args: string[]) => Promise<CommandOutcome | void>;
}

/** 交互壳插件：REPL/TUI/单发都是并列的壳，一次只起一个 */
export interface ShellPlugin {
  name: string;
  kind: 'shell';
  start: (app: App) => Promise<void>;
}

export type Plugin = ToolPlugin | ProviderPlugin | CommandPlugin | ShellPlugin;

/** 恒等函数：只为类型推导与将来校验留口，插件文件统一 `export default definePlugin({...})` */
export function definePlugin<P extends Plugin>(p: P): P {
  return p;
}
