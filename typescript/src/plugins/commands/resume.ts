// /resume：恢复历史会话。无编号=列最近 5 个；编号=加载并换新会话文件继续写。
import path from 'node:path';
import { definePlugin } from '../../kernel/plugin.ts';
import { c } from '../../kernel/ui.ts';

export default definePlugin({
  name: 'resume',
  kind: 'command',
  usage: '/resume [编号]',
  summary: '恢复历史会话（无编号=列最近 5 个）',
  async run(app, args) {
    const list = app.store.listRecent(5);
    if (list.length === 0) {
      console.log(c.yellow('暂无可恢复的历史会话。'));
      return;
    }
    const n = Number(args[0]);
    if (!Number.isInteger(n) || n < 1 || n > list.length) {
      console.log('最近的会话：');
      list.forEach((s, i) =>
        console.log(`  ${i + 1}. ${c.dim(new Date(s.mtime).toLocaleString())} ${s.label}`)
      );
      console.log(c.yellow(Number.isNaN(n) ? '用 /resume <编号> 加载' : `编号无效（1-${list.length}）`));
      return;
    }
    const picked = list[n - 1];
    const loaded = app.store.load(picked.file).filter((m) => m.role !== 'system');
    app.resetMessages();
    app.messages.push(...loaded);
    app.startSession({ resumedFrom: path.basename(picked.file) });
    console.log(c.green(`已恢复 ${loaded.length} 条消息，后续写入新会话文件。`));
  },
});
