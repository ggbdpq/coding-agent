"""路径守卫：解析模型给的路径，并标注目标是否越出当前工作目录。

pcode 的安全边界是权限确认（人工把关），本模块的职责是把越界目标
显式带出来，让确认界面能看到 "../" 或绝对路径这类穿越意图，而不是静默放行。
写白名单（R4）的判定也是纯路径逻辑，放这里与守卫同住。
非插件，是工具共享的工具函数。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


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


def inside_allow_dirs(file_path: str, allow_dirs: list[str]) -> bool:
    """白名单判定（R4）：目标 === 某白名单根目录，或位于其下 → True。

    两侧都过 Path.resolve 归一化（真实路径，消解 .. 与大小写差异由文件系统裁决）；
    白名单未配置（空列表）一律 False——没有配置就没有豁免。
    """
    if not allow_dirs:
        return False
    target = Path(file_path).resolve()
    return any(
        target == root or target.is_relative_to(root)
        for root in (Path(d).resolve() for d in allow_dirs)
    )
