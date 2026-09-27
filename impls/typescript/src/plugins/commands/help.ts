// /help：从注册表生成命令列表——新命令插件自动出现在帮助里。
import { definePlugin } from '../../kernel/plugin.ts';
import type { App } from '../../kernel/app.ts';

export function helpText(app: App): string {
  const rows = app.registry.commands().map((cmd) => `  ${cmd.usage.padEnd(15)}${cmd.summary}`);
  return [
    '命令：',
    ...rows,
    '其他输入直接作为对话发给模型。',
    'Ctrl+C：回答流式中=中止本轮；权限确认中=拒绝本次。',
  ].join('\n');
}

export default definePlugin({
  name: 'help',
  kind: 'command',
  usage: '/help',
  summary: '显示本帮助',
  async run(app) {
    console.log(helpText(app));
  },
});
