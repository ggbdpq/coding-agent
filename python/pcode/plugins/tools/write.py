"""write 工具：整文件写入（新文件/整体重写），自动建父目录。

模型给的路径先过路径守卫：越出工作目录的目标在权限确认时醒目提示，由人工把关。
"""
from __future__ import annotations

import os
from typing import Any

from pcode.kernel.plugin import ToolPlugin, define_plugin
from pcode.kernel.ui import ellipsis
from pcode.plugins.tools.pathguard import resolve_path


def _preview(args: dict[str, Any]) -> str:
    outside = resolve_path(str(args.get('file_path') or '')).outside
    flag = '\n⚠ 注意：该路径在当前工作目录之外！' if outside else ''
    return f"写入 {args.get('file_path')}{flag}\n{ellipsis(str(args.get('content') or ''), 4000)}"


def _run(args: dict[str, Any]) -> str:
    file = str(args.get('file_path') or '')
    if not file:
        return '错误：缺少 file_path'
    if args.get('content') is None:
        return '错误：缺少 content'
    content = str(args['content'])
    abs_path = resolve_path(file).abs
    os.makedirs(os.path.dirname(abs_path) or '.', exist_ok=True)
    with open(abs_path, 'w', encoding='utf-8', newline='') as f:
        f.write(content)
    line_count = len(content.split('\n'))
    return f'已写入 {file}（{len(content)} 字符 / {line_count} 行）'


plugin = define_plugin(
    ToolPlugin(
        name='write',
        kind='tool',
        description='将内容写入文件（整体覆盖，自动创建父目录）。修改已有文件请优先用 edit 做精确替换。',
        parameters={
            'type': 'object',
            'properties': {
                'file_path': {'type': 'string', 'description': '目标文件路径'},
                'content': {'type': 'string', 'description': '完整文件内容'},
            },
            'required': ['file_path', 'content'],
        },
        needs_permission=True,
        preview=_preview,
        run=_run,
    )
)
