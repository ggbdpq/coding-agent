"""/sessions：列出最近会话（v0.4-3，对齐 tcode commands/sessions.ts）。

列表视图；加载仍用 /resume <编号>。
"""
from __future__ import annotations

from datetime import datetime

from pcode.kernel.app import App
from pcode.kernel.plugin import CommandOutcome, CommandPlugin, define_plugin
from pcode.kernel.ui import dim, yellow


def _run(app: App, _args: list[str]) -> CommandOutcome | None:
    sessions = app.store.list_recent(5)
    if not sessions:
        print(yellow('暂无历史会话。'))
        return None
    print('最近的会话：')
    for i, s in enumerate(sessions):
        stamp = datetime.fromtimestamp(s.mtime).strftime('%Y-%m-%d %H:%M:%S')
        print(f'  {i + 1}. {dim(stamp)} {s.label}')
    return None


plugin = define_plugin(
    CommandPlugin(
        name='sessions',
        usage='/sessions',
        summary='列出最近会话（用 /resume <编号> 加载）',
        run=_run,
    )
)
