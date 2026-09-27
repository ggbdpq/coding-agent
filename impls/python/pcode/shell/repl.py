"""REPL 壳插件：读入 → 命令查表分发 → run_user_turn → 打印。命令本体都是插件，壳只管路由。

已知局限（同步模型的取舍，与 tcode 的 readline 版不同，写进 README）：
- Windows 标准库 input() 无历史记录（上下键不翻历史）。
- 轮中 Ctrl+C 直接退出进程（KeyboardInterrupt 无法像 tcode 那样分场景中止/拒绝）。
  会话文件仍会在退出前补齐断尾（见 core/turn.py），不会留下非法消息序列。
"""
from __future__ import annotations

import json
import os
import sys

from pcode.core.atrefs import capped_read, expand_at_refs
from pcode.core.permission import (
    PermissionDecision,
    PermissionRequest,
    create_permission_gate,
)
from pcode.core.turn import TurnHooks, run_user_turn
from pcode.kernel.app import App, VERSION
from pcode.kernel.plugin import ShellPlugin, define_plugin
from pcode.kernel.types import (
    AgentEvent,
    Compact,
    TextDelta,
    ToolCallEvent,
    ToolResult,
    Trimmed,
)
from pcode.kernel.ui import bold, cyan, dim, ellipsis, red, yellow


class _ReplPermissionIO:
    """权限 UI 适配：把"打印预览 + 问 y/n/a"接进统一闸门。"""

    def ask(self, req: PermissionRequest) -> PermissionDecision:
        print(f"\n{yellow(f'── {req.tool} 请求执行 ──')}\n{dim(req.preview)}")
        while True:
            try:
                ans = input(bold('允许? [y=允许 / n=拒绝 / a=本会话全部允许] ')).strip().lower()
            except EOFError:
                return 'deny'
            if ans == 'y':
                return 'allow'
            if ans == 'a':
                print(yellow('本会话后续操作不再逐次确认（可用 /yolo 切回）。'))
                return 'always'
            if ans in ('n', ''):
                return 'deny'
            print(dim('请回答 y / n / a'))


def start_repl(app: App) -> None:
    gate = create_permission_gate(_ReplPermissionIO(), app.yolo)

    def _render(ev: AgentEvent) -> None:
        """壳只是事件消费者：一个 switch 把规范事件翻译成终端输出。"""
        match ev:
            case TextDelta(delta=delta):
                sys.stdout.write(delta)
                sys.stdout.flush()
            case ToolCallEvent(name=name, args=args):
                print(
                    f"\n{cyan(f'⚙ {name}')} "
                    f"{dim(ellipsis(json.dumps(args, ensure_ascii=False), 120))}"
                )
            case ToolResult(summary=summary, ms=ms):
                print(dim(f'  ↳ {ellipsis(summary, 100)} ({ms}ms)'))
            case Trimmed(count=count):
                print(dim(f'（上下文超预算，已省略 {count} 条早期工具输出）'))
            case Compact(saved_tokens=saved):
                print(dim(f'（上下文超预算，已压缩为摘要 + 最近原文，节省约 {saved} tokens）'))
            case _:
                pass  # turn_start/user/usage/turn_end 等在 REPL 无专属展示

    banner = [f'{bold("pcode")} v{VERSION} {dim(f"· {app.config.model} · {os.getcwd()}")}']
    if app.yolo.value:
        banner.append(yellow('当前 --yolo：所有操作免确认'))
    banner.append(dim('输入 /help 查看命令，/exit 退出'))
    print('\n'.join(banner))

    while True:
        try:
            line = input(cyan('pcode❯ ')).strip()
        except EOFError:
            break
        if not line:
            continue

        # @文件引用：把 @path 展开为注入内容块（读取上限 1MB，再由 atrefs 截断）
        line = expand_at_refs(line, capped_read)

        if line.startswith('/'):
            parts = line.split()
            command = next(
                (cmd for cmd in app.registry.commands() if cmd.name == parts[0][1:]), None
            )
            if command is None:
                print(yellow(f'未知命令 {parts[0]}，/help 查看可用命令。'))
                continue
            outcome = command.run(app, parts[1:])
            if outcome is not None and outcome.exit:
                break
            continue

        try:
            run_user_turn(app, line, TurnHooks(emit=_render, check=gate))
            sys.stdout.write('\n')
        except KeyboardInterrupt:
            # 已知局限：同步模型下无法中止本轮后继续，直接退出进程
            print('\n（已退出：pcode 暂不支持轮中 Ctrl+C 后继续对话）')
            break
        except Exception as err:
            print(red(f'出错了：{err}'))


plugin = define_plugin(ShellPlugin(name='repl', kind='shell', start=start_repl))
