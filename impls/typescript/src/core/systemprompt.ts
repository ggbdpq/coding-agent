// 系统提示词：tcode 身份 + 运行环境 + 指令文件注入 + 技能索引。
// 注入顺序：~/.tcode/AGENTS.md（全局）在前，项目根 AGENTS.md 在后（后者更具体）。
// Skill 约定（蓝图 §三-13）：~/.tcode/skills/*.md 与 <cwd>/.tcode/skills/*.md 为技能库，
// 此处只注入"可用技能索引"，正文由 agent 按需用 read 工具读取——最小机制，无加载器。
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function readIfExists(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

/** 技能索引：列出技能目录中每个 .md 的名字与首行说明（无目录返回 null） */
export function discoverSkills(dirs: string[]) {
  const skills: Array<{ name: string; description: string; path: string }> = [];
  for (const rawDir of dirs) {
    const dir = path.resolve(rawDir);
    if (!existsSync(dir)) continue;
    // 目录存在但读不了（如权限）：stderr 警告一行后跳过——不静默（让用户看得见），
    // 也不打断启动（skillIndex 在 fresh_messages 闭包语境被调用，上抛会击穿装配）
    let entries: string[];
    try {
      if (lstatSync(dir).isSymbolicLink() || lstatSync(path.dirname(dir)).isSymbolicLink()) continue;
      entries = readdirSync(dir);
    } catch (e) {
      process.stderr.write(`skill 索引：跳过不可读目录 ${dir}（${(e as Error).message}）\n`);
      continue;
    }
    for (const f of entries.filter((x) => x.endsWith('.md'))) {
      const full = path.resolve(dir, f);
      // 边界自检（规范惯用法）：文件必须位于技能目录之内
      if (!full.startsWith(dir + path.sep)) continue;
      let desc = '';
      try {
        if (!lstatSync(full).isFile()) continue;
        const first = readFileSync(full, 'utf8')
          .split('\n')
          .find((l) => l.trim());
        desc = (first ?? '').replace(/^#+\s*/, '').slice(0, 60);
      } catch {
        /* 读不了就只列名字 */
      }
      skills.push({ name: f, description: desc, path: full });
    }
  }
  return skills;
}

export function skillIndex(dirs: string[]): string | null {
  const skills = discoverSkills(dirs);
  return skills.length ? ['## 可用技能（按需用 read 读取全文）', ...skills.map((skill) => `- ${skill.path}：${skill.description}（用 read 工具按需读取全文）`)].join('\n') : null;
}

const MAX_MEMORY_LINES = 200;

/** 记忆注入整理：按行去重（保留首次出现），超过上限保留最新并提示省略；文件本身不动 */
export function memorySection(content: string): string | null {
  const lines = content.trim().split('\n').filter((line) => line.trim() && !line.startsWith('#'));
  if (!lines.length) return null;
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    entries.push(line);
  }
  const omitted = entries.length - MAX_MEMORY_LINES;
  const kept = omitted > 0 ? entries.slice(omitted) : entries;
  const head = ['# 长期记忆（memory.md，跨会话沉淀，供参考不必复述；新增条目用 memory_append 工具追加）'];
  if (omitted > 0) head.push(`（已省略最早 ${omitted} 条，完整内容见 memory.md）`);
  return [...head, ...kept].join('\n');
}

export function buildSystemPrompt(cwd: string, homeDir?: string, dataDir?: string): string {
  const home = path.resolve(homeDir ?? homedir());
  const globalDir = path.resolve(dataDir ?? path.join(home, '.tcode'));
  const today = new Date().toISOString().slice(0, 10);
  const parts = [
    '你是 tcode，一个直接运行在用户本地终端的极简 coding agent。',
    `当前工作目录：${cwd}`,
    `操作系统：${process.platform}；今天日期：${today}`,
    '',
    '工作原则：',
    '- 动手改代码前先 read 相关文件，弄清上下文再动手。',
    '- 修改文件用 edit 做精确替换，old_string 必须带足够上下文保证唯一；新文件才用 write。',
    '- 跨文件多处一致的修改用 apply_patch 批量补丁（每个规范路径一条编辑，先全部预验再逐文件写入；写入失败不保证回滚）。',
    '- 修改后用 bash 运行相关测试或命令验证，如实报告结果，绝不谎报通过。',
    '- 找不到文件时先用 glob/grep 定位，不要瞎猜路径。',
    '- 回答用简体中文，简洁直接。',
  ];
  const global = readIfExists(path.join(globalDir, 'AGENTS.md'));
  if (global) parts.push('', '# 用户全局指令（~/.tcode/AGENTS.md）', global);
  const memory = readIfExists(path.join(globalDir, 'memory.md'));
  const memoryBlock = memory ? memorySection(memory) : null;
  if (memoryBlock) parts.push('', memoryBlock);
  const project = readIfExists(path.join(path.resolve(cwd), 'AGENTS.md'));
  if (project) parts.push('', '# 项目指令（AGENTS.md）', project);
  const skills = skillIndex([
    path.join(globalDir, 'skills'),
    path.join(path.resolve(cwd), '.tcode', 'skills'),
  ]);
  if (skills) parts.push('', skills);
  return parts.join('\n');
}
