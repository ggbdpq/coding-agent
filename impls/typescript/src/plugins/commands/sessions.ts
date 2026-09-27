// /sessions：列出最近会话（/resume 无编号的列表视图；加载仍用 /resume <编号>）。
import { definePlugin } from '../../kernel/plugin.ts';
import { c } from '../../kernel/ui.ts';

export default definePlugin({
  name: 'sessions',
  kind: 'command',
  usage: '/sessions',
  summary: '列出最近会话（用 /resume <编号> 加载）',
  async run(app) {
    const list = app.store.listRecent(5);
    if (list.length === 0) {
      console.log(c.yellow('暂无历史会话。'));
      return;
    }
    console.log('最近的会话：');
    list.forEach((s, i) =>
      console.log(`  ${i + 1}. ${c.dim(new Date(s.mtime).toLocaleString())} ${s.label}`)
    );
  },
});
