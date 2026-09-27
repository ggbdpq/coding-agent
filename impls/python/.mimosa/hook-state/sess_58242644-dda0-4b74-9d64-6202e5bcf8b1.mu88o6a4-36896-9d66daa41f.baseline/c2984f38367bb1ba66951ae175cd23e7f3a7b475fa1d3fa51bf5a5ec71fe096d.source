"""/resume：恢复历史会话。无编号=列最近 5 个；编号=加载并换新会话文件继续写。"""
from __future__ import annotations

import os
from datetime import datetime

from pcode.kernel.app import App
from pcode.kernel.plugin import CommandOutcome, CommandPlugin, define_plugin
from pcode.kernel.ui import dim, green, yellow


def _run(app: App, args: list[str]) -> CommandOutcome | None:
    sessions = app.store.list_recent(5)
    if not sessions:
        print(yellow('暂无可恢复的历史会话。'))
        return None

    # 无参数或参数不是整数 → 0（提示用法）；整数但越界 → 负数语义（提示编号无效）
    n = 0
    if args:
        try:
            n = int(args[0])
        except ValueError:
            n = 0

    if n < 1 or n > len(sessions):
        print('最近的会话：')
        for i, s in enumerate(sessions):
            stamp = datetime.fromtimestamp(s.mtime).strftime('%Y-%m-%d %H:%M:%S')
            print(f'  {i + 1}. {dim(stamp)} {s.label}')
        if n == 0:
            print(yellow('用 /resume <编号> 加载'))
        else:
            print(yellow(f'编号无效（1-{len(sessions)}）'))
        return None

    picked = sessions[n - 1]
    loaded = [m for m in app.store.load(picked.file) if m.get('role') != 'system']
    app.reset_messages()
    app.messages.extend(loaded)
    app.start_session({'resumedFrom': os.path.basename(picked.file)})
    print(green(f'已恢复 {len(loaded)} 条消息，后续写入新会话文件。'))
    return None


plugin = define_plugin(
    CommandPlugin(
        name='resume',
        usage='/resume [编号]',
        summary='恢复历史会话（无编号=列最近 5 个）',
        run=_run,
    )
)
