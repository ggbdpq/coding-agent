// REPL 壳插件：读入 → 命令查表分发 → runUserTurn → 打印。命令本体都是插件，壳只管路由。
import readline from 'node:readline/promises';
import { runUserTurn } from '../core/turn.ts';
import { createPermissionGate } from '../core/permission.ts';
import { c, ellipsis } from '../kernel/ui.ts';
import { VERSION, type App } from '../kernel/app.ts';
import { definePlugin } from '../kernel/plugin.ts';

export async function startRepl(app: App): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Ctrl+C 路由：权限确认中→拒绝本次；回答流式中→中止本轮；空闲→退出
  let abort: AbortController | null = null;
  let denyConfirm: (() => void) | null = null;
  rl.on('SIGINT', () => {
    if (denyConfirm) denyConfirm();
    else if (abort) abort.abort();
    else {
      rl.close();
      process.exit(0);
    }
  });

  // 权限 UI 适配：把"打印预览 + 问 y/n/a"接进统一闸门；确认中 Ctrl+C = 注入空行 = deny
  const gate = createPermissionGate(
    {
      ask: async ({ tool, preview }) => {
        const saved = abort;
        abort = null;
        denyConfirm = () => rl.write('\n');
        try {
          console.log(`\n${c.yellow(`── ${tool} 请求执行 ──`)}\n${c.dim(preview)}`);
          for (;;) {
            const ans = (await rl.question(c.bold('允许? [y=允许 / n=拒绝 / a=本会话全部允许] ')))
              .trim()
              .toLowerCase();
            if (ans === 'y') return 'allow';
            if (ans === 'a') {
              console.log(c.yellow('本会话后续操作不再逐次确认（可用 /yolo 切回）。'));
              return 'always';
            }
            if (ans === 'n' || ans === '') return 'deny';
            console.log(c.dim('请回答 y / n / a'));
          }
        } finally {
          denyConfirm = null;
          abort = saved;
        }
      },
    },
    app.yolo
  );

  console.log(
    [
      `${c.bold('gcode')} v${VERSION} ${c.dim(`· ${app.config.model} · ${process.cwd()}`)}`,
      app.yolo.value ? c.yellow('当前 --yolo：所有操作免确认') : '',
      c.dim('输入 /help 查看命令，/exit 退出'),
    ]
      .filter(Boolean)
      .join('\n')
  );

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(c.cyan('gcode❯ '))).trim();
    } catch {
      break; // stdin 关闭
    }
    if (!line) continue;

    if (line.startsWith('/')) {
      const [rawCmd, ...args] = line.split(/\s+/);
      const cmd = app.registry.commands().find((x) => x.name === rawCmd.slice(1));
      if (!cmd) {
        console.log(c.yellow(`未知命令 ${rawCmd}，/help 查看可用命令。`));
        continue;
      }
      const outcome = await cmd.run(app, args);
      if (outcome?.exit) break;
      continue;
    }

    abort = new AbortController();
    try {
      await runUserTurn(app, line, {
        check: gate,
        signal: abort.signal,
        onText: (t) => process.stdout.write(t),
        onToolCall: (name, args) =>
          console.log(`\n${c.cyan(`⚙ ${name}`)} ${c.dim(ellipsis(JSON.stringify(args), 120))}`),
        onToolResult: (name, result, ms) =>
          console.log(c.dim(`  ↳ ${ellipsis(result.split('\n')[0], 100)} (${ms}ms)`)),
        onTrimmed: (count) => console.log(c.dim(`（上下文超预算，已省略 ${count} 条早期工具输出）`)),
      });
      process.stdout.write('\n');
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        console.log(c.yellow('\n（本轮已中止，上下文保留到上一个完整回答）'));
      } else {
        console.log(c.red(`出错了：${err.message}`));
      }
    } finally {
      abort = null;
    }
  }

  rl.close();
}

export default definePlugin({
  name: 'repl',
  kind: 'shell',
  start: startRepl,
});
