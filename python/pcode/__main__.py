"""入口：python -m pcode —— 装配：注册内置插件 → 创建 App → 起壳。

缺配置给中文指路，不甩堆栈。
"""
from __future__ import annotations

import argparse
import os
import sys

from pcode.core.session import SessionStore
from pcode.core.systemprompt import build_system_prompt
from pcode.kernel.app import VERSION, create_app
from pcode.kernel.config import load_config
from pcode.kernel.registry import Registry
from pcode.plugins import builtin_plugins


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='pcode',
        description='pcode —— 极简本地优先 coding agent',
        epilog=(
            '环境变量：PCODE_API_KEY / PCODE_BASE_URL / PCODE_MODEL / PCODE_PROTOCOL'
            '（或写 ~/.pcode/config.json）'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        '--yolo',
        action='store_true',
        help='跳过写文件/执行命令的逐次确认（会话内可用 /yolo 切换）',
    )
    parser.add_argument(
        '--version', action='version', version=f'%(prog)s v{VERSION}', help='显示版本'
    )
    return parser


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
    try:
        config = load_config()
        registry = Registry().register_all(builtin_plugins)
        app = create_app(
            config,
            registry,
            yolo=args.yolo,
            fresh_messages=lambda: [
                {'role': 'system', 'content': build_system_prompt(os.getcwd())}
            ],
            store=SessionStore(os.path.join(config.pcode_dir, 'sessions')),
        )
        shell = registry.shell('repl')
        if shell is None:
            raise RuntimeError('找不到 shell 插件：repl')
        shell.start(app)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        print(f'启动失败：{e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
