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


def preview_diff(old_text: str, new_text: str, max_lines: int = 40) -> str:
    """旧文本 → 新文本的简易行级 diff 预览（前缀 +/-，保留两侧公共首尾行减少噪音）。

    不做 LCS 最小 diff——确认预览要的是"改了什么"而非"最短编辑脚本"（与 tcode 同决策）；
    需要精确 diff 时升级为独立渲染器。
    """
    old_lines = old_text.split('\n')
    new_lines = new_text.split('\n')
    # 公共前缀/后缀
    pre = 0
    while pre < len(old_lines) and pre < len(new_lines) and old_lines[pre] == new_lines[pre]:
        pre += 1
    suf = 0
    while (
        suf < len(old_lines) - pre
        and suf < len(new_lines) - pre
        and old_lines[len(old_lines) - 1 - suf] == new_lines[len(new_lines) - 1 - suf]
    ):
        suf += 1
    removed = [f'-{line}' for line in old_lines[pre:len(old_lines) - suf]]
    added = [f'+{line}' for line in new_lines[pre:len(new_lines) - suf]]
    ctx_before = [f' {line}' for line in old_lines[max(0, pre - 2):pre]]
    ctx_after = [f' {line}' for line in new_lines[len(new_lines) - suf:len(new_lines) - suf + 2]]
    lines = [*ctx_before, *removed, *added, *ctx_after]
    body = '\n'.join(lines[:max_lines])
    if len(lines) > max_lines:
        return f'{body}\n…（diff 共 {len(lines)} 行，已截断）'
    return body
