"""glob 工具：按 glob 模式列文件（ripgrep，尊重 .gitignore）。一工具一文件。"""
from __future__ import annotations

from typing import Any

from pcode.kernel.plugin import ToolPlugin, define_plugin
from pcode.plugins.tools.rg import run_rg


def _preview(args: dict[str, Any]) -> str:
    return f"glob {args.get('pattern')}"


def _run(args: dict[str, Any]) -> str:
    pattern = str(args.get('pattern') or '')
    if not pattern:
        return '错误：缺少 pattern'
    return run_rg(['--files', '-g', pattern])


plugin = define_plugin(
    ToolPlugin(
        name='glob',
        kind='tool',
        description='按 glob 模式列文件（尊重 .gitignore），如 "*.py"、"src/**/*.test.py"',
        parameters={
            'type': 'object',
            'properties': {
                'pattern': {'type': 'string', 'description': 'glob 模式'},
            },
            'required': ['pattern'],
        },
        needs_permission=False,
        preview=_preview,
        run=_run,
    )
)
