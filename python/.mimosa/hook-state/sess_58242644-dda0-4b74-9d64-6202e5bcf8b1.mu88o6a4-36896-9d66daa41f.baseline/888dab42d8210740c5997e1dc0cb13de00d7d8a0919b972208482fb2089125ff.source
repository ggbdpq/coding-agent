"""/plan：切换 Plan Mode（只读规划）。开启时写类工具在 agent_loop 被拒，

引导模型只读探索并产出计划；关闭后恢复正常执行。
系统提示词的 Plan Mode 分节由本命令直接维护在 messages[0] 上。
"""
from __future__ import annotations

from pcode.kernel.app import App
from pcode.kernel.plugin import CommandOutcome, CommandPlugin, define_plugin
from pcode.kernel.ui import green, yellow

PLAN_SECTION = (
    '\n# Plan Mode（当前生效）'
    '\n当前为只读规划阶段：禁止 write/edit/bash/web_fetch 等写类操作。'
    '\n请用 read/glob/grep 只读探索，并用 todo 工具把分步计划记录下来；'
    '\n计划完成后明确告知用户：切换回普通模式（/plan）执行。'
)


def _run(app: App, _args: list[str]) -> CommandOutcome | None:
    app.plan_mode.value = not app.plan_mode.value
    sys_msg = app.messages[0]
    if app.plan_mode.value:
        content = sys_msg.get('content')
        if content is None or '# Plan Mode' not in content:
            sys_msg['content'] = (content or '') + PLAN_SECTION
        print(yellow('已进入 Plan Mode：只读探索与规划，写类工具将被拒绝。'))
    else:
        content = sys_msg.get('content')
        if content:
            sys_msg['content'] = content.split('\n# Plan Mode（当前生效）')[0]
        print(green('已退出 Plan Mode，恢复正常执行。'))
    return None


plugin = define_plugin(
    CommandPlugin(
        name='plan',
        usage='/plan',
        summary='切换 Plan Mode（只读规划 ↔ 普通执行）',
        run=_run,
    )
)
