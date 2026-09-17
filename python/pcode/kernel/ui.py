"""终端着色与截断：零依赖 ANSI，仅在 TTY 上着色（重定向/冒烟测试输出保持干净）。

放 kernel：core 与 plugins 两层都要用，属共享工具。
"""
from __future__ import annotations

import sys
from typing import Callable

_TTY = sys.stdout.isatty()


def _wrap(code: str) -> Callable[[str], str]:
    def color(s: str) -> str:
        if _TTY:
            return f'\x1b[{code}m{s}\x1b[0m'
        return s

    return color


dim = _wrap('2')
cyan = _wrap('36')
green = _wrap('32')
yellow = _wrap('33')
red = _wrap('31')
bold = _wrap('1')


def ellipsis(s: str, max_chars: int) -> str:
    """超长文本截断，末尾标注省略了多少字符。"""
    if len(s) <= max_chars:
        return s
    return f'{s[:max_chars]}\n…（已截断，省略 {len(s) - max_chars} 字符）'
