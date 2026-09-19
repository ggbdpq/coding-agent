"""权限闸门：write/edit/bash/web_fetch 等写类操作逐次确认；--yolo / 回答"本会话全部允许"放行整个会话。

这是 pcode 的核心安全边界。闸门语义全项目只有这一份：
壳（REPL/web）只提供 ask 的 UI 适配，返回 allow/deny/always 三态决定。
按分层规则留在 core：安全边界不开放替换，也不进插件注册表。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal, Protocol

from pcode.kernel.types import YoloRef

PermissionDecision = Literal['allow', 'deny', 'always']


@dataclass
class PermissionRequest:
    tool: str
    preview: str


class PermissionIO(Protocol):
    def ask(self, req: PermissionRequest) -> PermissionDecision: ...


def create_permission_gate(
    io: PermissionIO, yolo_ref: YoloRef
) -> Callable[[str, str], bool]:
    def gate(tool_name: str, preview: str) -> bool:
        if yolo_ref.value:
            return True
        decision = io.ask(PermissionRequest(tool=tool_name, preview=preview))
        if decision == 'always':
            yolo_ref.value = True
        return decision != 'deny'

    return gate
