// /yolo：切换本会话免确认模式（与 --yolo 启动参数、权限确认里的 a 改的是同一个开关）。
import { definePlugin } from '../../kernel/plugin.ts';
import { c } from '../../kernel/ui.ts';

export default definePlugin({
  name: 'yolo',
  kind: 'command',
  usage: '/yolo',
  summary: '切换本会话免确认模式',
  async run(app) {
    app.yolo.value = !app.yolo.value;
    console.log(app.yolo.value ? c.yellow('已开启免确认（yolo）。') : c.green('已恢复逐次确认。'));
  },
});
