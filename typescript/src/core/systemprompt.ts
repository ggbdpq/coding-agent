// 系统提示词：tcode 身份 + 运行环境 + 指令文件注入。
// 注入顺序：~/.tcode/AGENTS.md（全局）在前，项目根 AGENTS.md 在后（后者更具体）。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function readIfExists(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(cwd: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const parts = [
    '你是 tcode，一个直接运行在用户本地终端的极简 coding agent。',
    `当前工作目录：${cwd}`,
    `操作系统：${process.platform}；今天日期：${today}`,
    '',
    '工作原则：',
    '- 动手改代码前先 read 相关文件，弄清上下文再动手。',
    '- 修改文件用 edit 做精确替换，old_string 必须带足够上下文保证唯一；新文件才用 write。',
    '- 修改后用 bash 运行相关测试或命令验证，如实报告结果，绝不谎报通过。',
    '- 找不到文件时先用 glob/grep 定位，不要瞎猜路径。',
    '- 回答用简体中文，简洁直接。',
  ];
  const global = readIfExists(path.join(homedir(), '.tcode', 'AGENTS.md'));
  if (global) parts.push('', '# 用户全局指令（~/.tcode/AGENTS.md）', global);
  const project = readIfExists(path.join(cwd, 'AGENTS.md'));
  if (project) parts.push('', '# 项目指令（AGENTS.md）', project);
  return parts.join('\n');
}
