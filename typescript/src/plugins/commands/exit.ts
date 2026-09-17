// /exit：返回 exit 信号，由壳（repl）负责收尾退出。
import { definePlugin } from '../../kernel/plugin.ts';

export default definePlugin({
  name: 'exit',
  kind: 'command',
  usage: '/exit',
  summary: '退出（Ctrl+C 亦可）',
  run: async () => ({ exit: true }),
});
