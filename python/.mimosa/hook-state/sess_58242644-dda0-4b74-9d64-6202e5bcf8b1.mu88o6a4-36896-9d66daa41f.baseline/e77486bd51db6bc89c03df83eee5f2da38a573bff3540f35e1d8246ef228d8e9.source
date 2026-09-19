"""@文件引用（v0.4-2，对齐 tcode core/atrefs.ts）：把输入里的 @path 注入对应文件内容。

纯函数（读文件经参数注入，方便单测）；只读不写，无需权限闸门。
已知取舍（与 tcode 一致）：路径含空格不支持（@token 以空白分隔）；@目录 不展开——需要时升级。
"""
from __future__ import annotations

import os
import re
from typing import Callable

MAX_FILE_CHARS = 256 * 1024

# @token 以空白分隔、且必须紧跟行首或空白（邮箱 someone@example.com 不误伤）
_AT_REF_RE = re.compile(r'(^|\s)@([^\s@]+)')

# 供 @引用 读取的读文件函数：读不到（不存在/目录/越权失败）返回 None
ReadFileFunc = Callable[[str], 'str | None']


def capped_read(p: str) -> str | None:
    """供 @引用 读取的封顶读文件（1MB 内全读，超出截断）；目录/读失败返回 None。

    tcode 在 main.ts 与 repl.ts 各写了一份，pcode 收敛到这里共用。
    """
    try:
        abspath = os.path.abspath(p)
        if os.path.isdir(abspath):
            return None
        with open(abspath, 'rb') as f:
            data = f.read(1024 * 1024)
        return data.decode('utf-8', errors='replace')
    except (OSError, ValueError):
        return None


def expand_at_refs(line: str, read_func: ReadFileFunc) -> str:
    def _replace(m: re.Match[str]) -> str:
        lead, raw_path = m.group(1), m.group(2)
        content = read_func(raw_path)
        if content is None:
            return f'{lead}@{raw_path}（文件不存在）'
        if len(content) > MAX_FILE_CHARS:
            body = f'{content[:MAX_FILE_CHARS]}\n…（已截断，原文 {len(content)} 字符）'
        else:
            body = content
        return f'{lead}[引用文件 {raw_path}]\n{body}\n[/引用文件]'

    return _AT_REF_RE.sub(_replace, line)
