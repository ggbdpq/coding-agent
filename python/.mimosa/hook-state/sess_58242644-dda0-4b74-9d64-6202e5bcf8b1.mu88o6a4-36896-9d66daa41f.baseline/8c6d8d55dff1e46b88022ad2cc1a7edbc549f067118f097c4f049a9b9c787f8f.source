"""/new：开新会话——messages 换新 system 数组并换新会话文件。"""
from __future__ import annotations

from pcode.kernel.app import App
from pcode.kernel.plugin import CommandOutcome, CommandPlugin, define_plugin
from pcode.kernel.ui import green


def _run(app: App, _args: list[str]) -> CommandOutcome | None:
    app.reset_messages()
    app.start_session()
    print(green('已开新会话，上下文已清空。'))
    return None


plugin = define_plugin(
    CommandPlugin(name='new', usage='/new', summary='开新会话（清空上下文）', run=_run)
)
