// /plan：切换 Plan Mode（只读规划）。开启时写类工具在 agentloop 被拒，
// 引导模型只读探索并产出计划；关闭后恢复正常执行。
// 系统提示词的 Plan Mode 分节由本命令直接维护在 messages[0] 上。
import { definePlugin, type CommandOutcome } from '../../kernel/plugin.ts';
import { c } from '../../kernel/ui.ts';

const PLAN_SECTION = [
  '',
  '# Plan Mode（当前生效）',
  '当前为只读规划阶段：禁止 write/edit/bash/web_fetch 等写类操作。',
  '请用 read/glob/grep 只读探索，并用 todo 工具把分步计划记录下来；',
  '计划完成后明确告知用户：切换回普通模式（/plan）执行。',
].join('\n');

export default definePlugin({
  name: 'plan',
  kind: 'command',
  usage: '/plan',
  summary: '切换 Plan Mode（只读规划 ↔ 普通执行）',
  async run(app): Promise<CommandOutcome | void> {
    app.planMode.value = !app.planMode.value;
    const sys = app.messages[0];
    if (app.planMode.value) {
      if (!sys.content?.includes('# Plan Mode')) sys.content = (sys.content ?? '') + PLAN_SECTION;
      console.log(c.yellow('已进入 Plan Mode：只读探索与规划，写类工具将被拒绝。'));
    } else {
      if (sys.content) {
        sys.content = sys.content.split('\n# Plan Mode（当前生效）')[0];
      }
      console.log(c.green('已退出 Plan Mode，恢复正常执行。'));
    }
  },
});
