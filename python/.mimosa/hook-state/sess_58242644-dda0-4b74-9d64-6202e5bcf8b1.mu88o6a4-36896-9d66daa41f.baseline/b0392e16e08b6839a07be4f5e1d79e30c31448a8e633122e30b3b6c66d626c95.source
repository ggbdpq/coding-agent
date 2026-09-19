"""/exit：返回 exit 信号，由壳（repl）负责收尾退出。"""
from __future__ import annotations

from pcode.kernel.app import App
from pcode.kernel.plugin import CommandOutcome, CommandPlugin, define_plugin


def _run(_app: App, _args: list[str]) -> CommandOutcome | None:
    return CommandOutcome(exit=True)


plugin = define_plugin(
    CommandPlugin(name='exit', usage='/exit', summary='退出（Ctrl+C 亦可）', run=_run)
)
