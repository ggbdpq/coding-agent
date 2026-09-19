"""/yolo：切换本会话免确认模式（与 --yolo 启动参数、权限确认里的 a 改的是同一个开关）。"""
from __future__ import annotations

from pcode.kernel.app import App
from pcode.kernel.plugin import CommandOutcome, CommandPlugin, define_plugin
from pcode.kernel.ui import green, yellow


def _run(app: App, _args: list[str]) -> CommandOutcome | None:
    app.yolo.value = not app.yolo.value
    print(yellow('已开启免确认（yolo）。') if app.yolo.value else green('已恢复逐次确认。'))
    return None


plugin = define_plugin(
    CommandPlugin(name='yolo', usage='/yolo', summary='切换本会话免确认模式', run=_run)
)
