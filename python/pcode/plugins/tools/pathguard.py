"""路径守卫：解析模型给的路径，并标注目标是否越出当前工作目录。

pcode 的安全边界是权限确认（人工把关），本模块的职责是把越界目标
显式带出来，让确认界面能看到 "../" 或绝对路径这类穿越意图，而不是静默放行。
非插件，是工具共享的工具函数。
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class ResolvedPath:
    abs: str
    # True = 目标在当前工作目录之外，写类操作确认时会醒目提示
    outside: bool


def resolve_path(user_input: str) -> ResolvedPath:
    abs_path = os.path.abspath(user_input)
    try:
        rel = os.path.relpath(abs_path, os.getcwd())
    except ValueError:
        # Windows 跨盘符算不出相对路径：目标必然在 cwd 之外
        return ResolvedPath(abs=abs_path, outside=True)
    outside = rel.startswith('..') or os.path.isabs(rel)
    return ResolvedPath(abs=abs_path, outside=outside)
