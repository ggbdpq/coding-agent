"""grep 工具：按正则搜文件内容（ripgrep，尊重 .gitignore）。一工具一文件。"""
from __future__ import annotations

from typing import Any

from pcode.kernel.plugin import ToolPlugin, define_plugin
from pcode.plugins.tools.rg import run_rg


def _preview(args: dict[str, Any]) -> str:
    return f"grep {args.get('pattern')}"


def _run(args: dict[str, Any]) -> str:
    pattern = str(args.get('pattern') or '')
    if not pattern:
        return '错误：缺少 pattern'
    rg_args = ['-n', '-S']
    if args.get('include'):
        rg_args += ['-g', str(args['include'])]
    rg_args += ['--', pattern, str(args.get('path') or '.')]
    return run_rg(rg_args)


plugin = define_plugin(
    ToolPlugin(
        name='grep',
        kind='tool',
        description='按正则搜文件内容（ripgrep 语法，智能大小写），返回 行号:内容',
        parameters={
            'type': 'object',
            'properties': {
                'pattern': {'type': 'string', 'description': '正则表达式'},
                'path': {'type': 'string', 'description': '限定搜索的目录或文件，默认当前目录'},
                'include': {'type': 'string', 'description': '文件名 glob 过滤，如 "*.py"'},
            },
            'required': ['pattern'],
        },
        needs_permission=False,
        preview=_preview,
        run=_run,
    )
)
