"""read 工具：带行号读文件，支持 offset/limit 分段；超大文件拒读并提示分段。

路径先过守卫统一解析（读操作免确认，但解析规则与写类保持一致）。
"""
from __future__ import annotations

import os
from typing import Any

from pcode.kernel.plugin import ToolPlugin, define_plugin
from pcode.plugins.tools.pathguard import resolve_path

MAX_BYTES = 1024 * 1024
DEFAULT_LIMIT = 2000


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _preview(args: dict[str, Any]) -> str:
    return f"read {args.get('file_path')}"


def _run(args: dict[str, Any]) -> str:
    file = str(args.get('file_path') or '')
    if not file:
        return '错误：缺少 file_path'
    abs_path = resolve_path(file).abs
    if not os.path.exists(abs_path):
        return f'错误：文件不存在：{file}'
    if os.path.isdir(abs_path):
        return f'错误：{file} 是目录，请用 glob 列文件'
    size = os.path.getsize(abs_path)
    if size > MAX_BYTES:
        return f'错误：文件过大（{size} 字节，上限 {MAX_BYTES}），请用 offset/limit 分段读取'
    try:
        with open(abs_path, encoding='utf-8', errors='replace', newline='') as f:
            text = f.read()
    except OSError as e:
        return f'错误：无法读取 {file}：{e}'
    lines = text.split('\n')
    total = len(lines)
    start = max(0, min(_to_int(args.get('offset'), 1) - 1, total - 1))
    limit = max(1, _to_int(args.get('limit'), DEFAULT_LIMIT))
    window = lines[start : start + limit]
    body = '\n'.join(f'{start + i + 1}'.rjust(6) + f'\t{line}' for i, line in enumerate(window))
    note = ''
    if start + limit < total:
        note = f'\n（已显示第 {start + 1}-{min(start + limit, total)} 行，共 {total} 行；继续读请调大 offset）'
    return body + note


plugin = define_plugin(
    ToolPlugin(
        name='read',
        kind='tool',
        description='读取文件内容，带行号（1-based）。大文件可用 offset（起始行）和 limit（最多行数）分段读取。',
        parameters={
            'type': 'object',
            'properties': {
                'file_path': {'type': 'string', 'description': '文件路径，相对当前目录或绝对路径'},
                'offset': {'type': 'number', 'description': '起始行号（1-based），默认 1'},
                'limit': {'type': 'number', 'description': f'最多读取行数，默认 {DEFAULT_LIMIT}'},
            },
            'required': ['file_path'],
        },
        needs_permission=False,
        preview=_preview,
        run=_run,
    )
)
