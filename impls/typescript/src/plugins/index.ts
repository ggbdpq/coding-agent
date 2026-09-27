// 内置插件清单：加插件 = 加文件 + 在这里挂一行。
// 显式组合而非目录扫描——装配顺序可读、可预测，对齐 dsh 的 bundle/profile 取向。
// 注意 openai provider 必须排在 provider 类的最后（matches 恒真，是兜底）。
import readPlugin from './tools/read.ts';
import writePlugin from './tools/write.ts';
import editPlugin from './tools/edit.ts';
import bashPlugin from './tools/bash.ts';
import globPlugin from './tools/glob.ts';
import grepPlugin from './tools/grep.ts';
import todoPlugin from './tools/todo.ts';
import webFetchPlugin from './tools/webfetch.ts';
import applyPatchPlugin from './tools/apply_patch.ts';
import helpCommand from './commands/help.ts';
import newCommand from './commands/new.ts';
import resumeCommand from './commands/resume.ts';
import yoloCommand from './commands/yolo.ts';
import planCommand from './commands/plan.ts';
import compactCommand from './commands/compact.ts';
import initCommand from './commands/init.ts';
import sessionsCommand from './commands/sessions.ts';
import exitCommand from './commands/exit.ts';
import anthropicPlugin from '../providers/anthropic.ts';
import openaiPlugin from '../providers/openai.ts';
import replPlugin from '../shell/repl.ts';
import webPlugin from '../shell/web.ts';
import type { Plugin } from '../kernel/plugin.ts';

export const builtinPlugins: Plugin[] = [
  // —— 工具 ——
  readPlugin,
  writePlugin,
  editPlugin,
  bashPlugin,
  globPlugin,
  grepPlugin,
  todoPlugin,
  webFetchPlugin,
  applyPatchPlugin,
  // —— 命令（/help 列表按这里的顺序展示） ——
  helpCommand,
  newCommand,
  resumeCommand,
  yoloCommand,
  planCommand,
  compactCommand,
  initCommand,
  sessionsCommand,
  exitCommand,
  // —— 协议（anthropic 在前按 URL 命中，openai 恒真兜底必须在后） ——
  anthropicPlugin,
  openaiPlugin,
  // —— 壳 ——
  replPlugin,
  webPlugin,
];
