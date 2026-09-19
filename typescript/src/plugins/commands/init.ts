// /init：在当前目录生成 AGENTS.md 起手模板（非 LLM 生成，确定性强；
// codex 式"让模型分析仓库生成"留作升级——需要事件流授权一个隐藏 turn）。
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { definePlugin, type CommandOutcome } from '../../kernel/plugin.ts';

const TEMPLATE = [
  '# AGENTS.md',
  '',
  '本文件是 tcode 在此项目工作的行为约束，每次会话自动注入。',
  '',
  '## 项目概要',
  '<用两三句话描述这个项目是做什么的>',
  '',
  '## 技术栈与命令',
  '- 构建：`<命令>`',
  '- 测试：`<命令>`',
  '- 格式化：`<命令>`',
  '',
  '## 工作约定',
  '- <例如：改代码前先跑相关测试>',
  '- <例如：提交信息用中文，遵循 conventional commits>',
  '- <例如：不要改 xxx 目录>',
].join('\n');

export default definePlugin({
  name: 'init',
  kind: 'command',
  usage: '/init',
  summary: '在当前目录生成 AGENTS.md 起手模板（已存在则不覆盖）',
  async run(app): Promise<CommandOutcome | void> {
    const file = path.join(process.cwd(), 'AGENTS.md');
    if (existsSync(file)) {
      console.log('AGENTS.md 已存在，未覆盖。可直接编辑它来调整项目约束。');
      return;
    }
    writeFileSync(file, TEMPLATE, 'utf8');
    console.log(`已生成 ${file}——编辑它补充项目概要、常用命令与工作约定，下次会话自动生效。`);
  },
});
