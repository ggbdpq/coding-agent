// REPL 壳插件：读入 → 命令查表分发 → runUserTurn → 打印。命令本体都是插件，壳只管路由。
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import readline from 'node:readline/promises';
import path from 'node:path';
import { runUserTurn } from '../core/turn.ts';
import { expandAtRefs } from '../core/atrefs.ts';
import { createPermissionGate } from '../core/permission.ts';
import { c, ellipsis } from '../kernel/ui.ts';
import type { AgentEvent } from '../kernel/types.ts';
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
      `${c.bold('tcode')} v${VERSION} ${c.dim(`· ${app.config.model} · ${process.cwd()}`)}`,
      app.yolo.value ? c.yellow('当前 --yolo：所有操作免确认') : '',
      c.dim('输入 /help 查看命令，/exit 退出'),
    ]
      .filter(Boolean)
      .join('\n')
  );

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(c.cyan('tcode❯ '))).trim();
    } catch {
      break; // stdin 关闭
    }
    if (!line) continue;

    // @文件引用：把 @path 展开为注入内容块（读取上限 1MB，再由 atrefs 截断）
    line = expandAtRefs(line, (p) => {
      try {
        const abs = path.resolve(p);
        const st = statSync(abs);
        if (st.isDirectory()) return null;
        const fd = openSync(abs, 'r');
        const buf = Buffer.alloc(Math.min(st.size, 1024 * 1024));
        const n = readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        return buf.toString('utf8', 0, n);
      } catch {
        return null;
      }
    });

    if (line.startsWith('/')) {
      const [rawCmd, ...args] = line.split(/\s+/);
      const cmd = app.registry.commands().find((x) => x.name === rawCmd.slice(1));
      if (!cmd) {
        console.log(c.yellow(`未知命令 ${rawCmd}，/help 查看可用命令。`));
        continue;
      }
      const outcome = await cmd
        .run(app, args)
        .catch((e: Error) => console.log(c.red(`命令执行出错：${e.message}`)));
      if (outcome?.exit) break;
      continue;
    }

    abort = new AbortController();
    try {
      await runUserTurn(app, line, {
        check: gate,
        signal: abort.signal,
        emit: renderToTerminal,
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

/** 终端渲染器：AgentEvent → 直接写终端（REPL 壳的展示层，无状态） */
function renderToTerminal(ev: AgentEvent): void {
  switch (ev.type) {
    case 'text_delta':
      process.stdout.write(ev.delta);
      break;
    case 'tool_call':
      console.log(`\n${c.cyan(`⚙ ${ev.name}`)} ${c.dim(ellipsis(JSON.stringify(ev.args), 120))}`);
      break;
    case 'tool_result':
      console.log(c.dim(`  ↳ ${ellipsis(ev.summary, 100)} (${ev.ms}ms)`));
      break;
    case 'trimmed':
      console.log(c.dim(`（上下文超预算，已省略 ${ev.count} 条早期工具输出）`));
      break;
    default:
      break; // turn_start/user/turn_end 的展示由横幅与提示符逻辑承担
  }
}

export default definePlugin({
  name: 'repl',
  kind: 'shell',
  start: startRepl,
});
