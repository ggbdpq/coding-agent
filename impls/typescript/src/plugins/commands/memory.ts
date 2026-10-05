// /memory：跨会话长期记忆——追加到 <数据目录>/memory.md，该文件由系统提示词注入每轮对话。
// 删改走文件本身（用户可直接编辑）；clear 一键清空。
import { existsSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { definePlugin } from '../../kernel/plugin.ts';
import { c } from '../../kernel/ui.ts';

export default definePlugin({
  name: 'memory',
  kind: 'command',
  usage: '/memory [内容 | clear]',
  summary: '查看/追加长期记忆（跨会话）',
  async run(app, args) {
    const file = path.join(app.config.tcodeDir, 'memory.md');
    if (args[0] === 'clear') {
      if (existsSync(file)) unlinkSync(file);
      console.log(c.green('已清空长期记忆。'));
      return;
    }
    const text = args.join(' ').trim();
    if (text) {
      appendFileSync(file, (existsSync(file) ? '' : '# 长期记忆\n') + `- ${text}\n`, { mode: 0o600 });
      console.log(c.green('已追加到长期记忆（本轮对话已注入，新追加内容下轮生效）：') + text);
      return;
    }
    if (!existsSync(file)) {
      console.log('长期记忆为空。用 /memory <内容> 追加一条，跨会话生效。');
      return;
    }
    console.log(readFileSync(file, 'utf8').trimEnd());
  },
});
