"""内置插件清单：加插件 = 加文件 + 在这里挂一行。

显式组合而非目录扫描——装配顺序可读、可预测，对齐 tcode 的取向。
注意 openai provider 必须排在 provider 类的最后（matches 恒真，是兜底）。
"""
from __future__ import annotations

from pcode.kernel.plugin import Plugin
from pcode.plugins.commands.exit import plugin as exit_command
from pcode.plugins.commands.help import plugin as help_command
from pcode.plugins.commands.new import plugin as new_command
from pcode.plugins.commands.resume import plugin as resume_command
from pcode.plugins.commands.yolo import plugin as yolo_command
from pcode.plugins.tools.bash import plugin as bash_plugin
from pcode.plugins.tools.edit import plugin as edit_plugin
from pcode.plugins.tools.glob import plugin as glob_plugin
from pcode.plugins.tools.grep import plugin as grep_plugin
from pcode.plugins.tools.read import plugin as read_plugin
from pcode.plugins.tools.todo import plugin as todo_plugin
from pcode.plugins.tools.web_fetch import plugin as web_fetch_plugin
from pcode.plugins.tools.write import plugin as write_plugin
from pcode.providers.anthropic import plugin as anthropic_plugin
from pcode.providers.openai import plugin as openai_plugin
from pcode.shell.repl import plugin as repl_plugin

builtin_plugins: list[Plugin] = [
    # —— 工具 ——
    read_plugin,
    write_plugin,
    edit_plugin,
    bash_plugin,
    glob_plugin,
    grep_plugin,
    todo_plugin,
    web_fetch_plugin,
    # —— 命令（/help 列表按这里的顺序展示） ——
    help_command,
    new_command,
    resume_command,
    yolo_command,
    exit_command,
    # —— 协议（anthropic 在前按 URL 命中，openai 恒真兜底必须在后） ——
    anthropic_plugin,
    openai_plugin,
    # —— 壳 ——
    repl_plugin,
]
