"""入口：python -m pcode —— 装配：注册内置插件 → 创建 App → 起壳（repl 或无交互 exec）。

缺配置给中文指路，不甩堆栈。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from pcode.core.atrefs import capped_read, expand_at_refs
from pcode.core.session import SessionStore
from pcode.core.systemprompt import build_system_prompt
from pcode.core.turn import TurnHooks, run_user_turn
from pcode.kernel.app import VERSION, App, create_app
from pcode.kernel.config import load_config
from pcode.kernel.registry import Registry
from pcode.kernel.types import AgentEvent, TextDelta, ToolCallEvent, ToolResult, TurnEnd
from pcode.plugins import builtin_plugins


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='pcode',
        description='pcode —— 极简本地优先 coding agent',
        epilog=(
            '环境变量：PCODE_API_KEY / PCODE_BASE_URL / PCODE_MODEL / PCODE_PROTOCOL'
            ' / PCODE_APPROVAL（或写 ~/.pcode/config.json）'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        'shell',
        nargs='?',
        default='repl',
        help="壳：repl（默认）或 exec（无交互执行单个任务后退出，须配 --yolo）",
    )
    parser.add_argument('task', nargs='*', help='exec 模式的任务描述（剩余参数以空格拼接）')
    parser.add_argument(
        '--yolo',
        action='store_true',
        help='跳过写文件/执行命令的逐次确认（会话内可用 /yolo 切换）',
    )
    parser.add_argument(
        '--continue',
        dest='resume_latest',
        action='store_true',
        help='启动时恢复最近一次会话',
    )
    parser.add_argument(
        '--version', action='version', version=f'%(prog)s v{VERSION}', help='显示版本'
    )
    return parser


def _resume_latest_session(app: App) -> None:
    """--continue：装载最近会话的非 system 消息，随后写入新会话文件（/resume 同语义）。"""
    latest = app.store.list_recent(1)
    if not latest:
        print('没有可恢复的会话，从新会话开始。')
        return
    loaded = [m for m in app.store.load(latest[0].file) if m.get('role') != 'system']
    app.messages.extend(loaded)
    app.start_session({'resumedFrom': os.path.basename(latest[0].file)})
    print(f'已恢复最近会话（{len(loaded)} 条消息）。')


def _run_exec(app: App, task_args: list[str]) -> int:
    """无交互模式：单任务跑完一轮即退出。返回进程退出码（0=完成 / 1=出错）。"""
    if not app.yolo.value:
        print(
            'exec 模式必须配合 --yolo（无交互环境无法逐次确认写操作）',
            file=sys.stderr,
        )
        return 1
    task = expand_at_refs(' '.join(task_args).strip(), capped_read)
    if not task:
        print('exec 需要任务描述：pcode exec "任务"', file=sys.stderr)
        return 1

    failed = False

    def render(ev: AgentEvent) -> None:
        """事件 → 纯文本行：无交互环境没有颜色和交互，只留可读的过程日志。"""
        nonlocal failed
        match ev:
            case TextDelta(delta=delta):
                sys.stdout.write(delta)
                sys.stdout.flush()
            case ToolCallEvent(name=name, args=cargs):
                print(f'\n[tool] {name} {json.dumps(cargs, ensure_ascii=False)[:160]}')
            case ToolResult(summary=summary, ms=ms):
                print(f'[result] {summary.splitlines()[0] if summary else ""} ({ms}ms)')
            case TurnEnd(reason=reason, error=error):
                if reason != 'completed':
                    print(f'\n[turn:{reason}]{error or ""}', file=sys.stderr)
                    failed = True
            case _:
                pass  # turn_start/user/usage/compact 等在 exec 无专属展示

    try:
        run_user_turn(app, task, TurnHooks(emit=render))
        sys.stdout.write('\n')
    except KeyboardInterrupt:
        print('\n（已中止）', file=sys.stderr)
        failed = True
    except Exception as e:
        print(f'错误：{e}', file=sys.stderr)
        failed = True
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> None:
    # Windows 管道下默认随 locale（如 cp936）：UTF-8 优先 + 行缓冲，流式输出才可见
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure is not None:
            try:
                reconfigure(encoding='utf-8', line_buffering=True)
            except TypeError:  # stdin 不支持 line_buffering
                reconfigure(encoding='utf-8')

    args = _build_parser().parse_args(argv)

    # 参数规整：第一个位置参数只认 repl/exec；否则整体视为 repl 的多余参数（与 tcode 同法）
    if args.shell in ('repl', 'exec'):
        shell_name, task_args = args.shell, args.task
        extra: list[str] = []
    else:
        shell_name, task_args = 'repl', []
        extra = [args.shell, *args.task]

    try:
        config = load_config()
        registry = Registry().register_all(builtin_plugins)
        app = create_app(
            config,
            registry,
            # 审批策略 never 与 --yolo 等价（R4）
            yolo=args.yolo or config.approval == 'never',
            fresh_messages=lambda: [
                {'role': 'system', 'content': build_system_prompt(os.getcwd())}
            ],
            store=SessionStore(os.path.join(config.pcode_dir, 'sessions')),
        )

        if args.resume_latest:
            _resume_latest_session(app)

        if shell_name == 'exec':
            sys.exit(_run_exec(app, task_args))

        if extra:
            print(f'提示：忽略多余参数：{" ".join(extra)}')
        shell = registry.shell(shell_name)
        if shell is None:
            raise RuntimeError(f'找不到 shell 插件：{shell_name}')
        shell.start(app)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        print(f'启动失败：{e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
