""" /help：从注册表生成命令列表——新命令插件自动出现在帮助里。"""
from __future__ import annotations

from pcode.kernel.app import App
from pcode.kernel.plugin import CommandOutcome, CommandPlugin, define_plugin


def help_text(app: App) -> str:
    rows = [f'  {cmd.usage:<15}{cmd.summary}' for cmd in app.registry.commands()]
    return '\n'.join(
        [
            '命令：',
            *rows,
            '其他输入直接作为对话发给模型。',
            'Ctrl+C：直接退出进程（同步模型的取舍，轮中无法分场景中止，详见 README 已知局限）。',
        ]
    )


def _run(app: App, _args: list[str]) -> CommandOutcome | None:
    print(help_text(app))
    return None


plugin = define_plugin(
    CommandPlugin(name='help', usage='/help', summary='显示本帮助', run=_run)
)
