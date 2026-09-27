"""/init：在当前目录生成 AGENTS.md 起手模板（v0.4-3，对齐 tcode commands/init.ts）。

非 LLM 生成，确定性强；已存在则不覆盖。
"""
from __future__ import annotations

import os

from pcode.kernel.app import App
from pcode.kernel.plugin import CommandOutcome, CommandPlugin, define_plugin
from pcode.kernel.ui import green

TEMPLATE = '\n'.join(
    [
        '# AGENTS.md',
        '',
        '本文件是 pcode 在此项目工作的行为约束，每次会话自动注入。',
        '',
        '## 项目概要',
        '<用两三句话描述这个项目是做什么的>',
        '',
        '## 技术栈与命令',
        '- 构建：`<命令>`',
        '- 测试：`<命令>`',
        '- 格式化：`<命令>`',
        '',
        '## 工作约定',
        '- <例如：改代码前先跑相关测试>',
        '- <例如：提交信息用中文，遵循 conventional commits>',
        '- <例如：不要改 xxx 目录>',
    ]
)


def _run(app: App, _args: list[str]) -> CommandOutcome | None:
    file = os.path.join(os.getcwd(), 'AGENTS.md')
    if os.path.exists(file):
        print('AGENTS.md 已存在，未覆盖。可直接编辑它来调整项目约束。')
        return None
    with open(file, 'w', encoding='utf-8', newline='\n') as f:
        f.write(TEMPLATE)
    print(green(f'已生成 {file}——编辑它补充项目概要、常用命令与工作约定，下次会话自动生效。'))
    return None


plugin = define_plugin(
    CommandPlugin(
        name='init',
        usage='/init',
        summary='在当前目录生成 AGENTS.md 起手模板（已存在则不覆盖）',
        run=_run,
    )
)
