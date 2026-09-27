"""todo 工具：会话内任务清单——插件 API 的活样例（对照 tcode 的 docs/plugin-template.md）。

状态存在本插件模块的闭包里：进程内存活，/new 不清空、退出即失；
刻意做小，只演示"加一个工具 = 加一个文件 + 清单一行"。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pcode.kernel.plugin import ToolPlugin, define_plugin


@dataclass
class _TodoItem:
    id: int
    text: str
    done: bool


_items: list[_TodoItem] = []
_next_id = 1


def _preview(args: dict[str, Any]) -> str:
    return f"todo {args.get('action')}"


def _run(args: dict[str, Any]) -> str:
    global _next_id
    action = str(args.get('action') or 'list')

    if action == 'add':
        text = str(args.get('text') or '').strip()
        if not text:
            return '错误：add 需要 text'
        item = _TodoItem(id=_next_id, text=text, done=False)
        _next_id += 1
        _items.append(item)
        return f'已添加 #{item.id}：{item.text}'

    if action == 'done':
        raw_id = args.get('id')
        try:
            target_id = int(raw_id)
        except (TypeError, ValueError):
            target_id = -1
        item = next((i for i in _items if i.id == target_id), None)
        if item is None:
            return f'错误：没有 #{raw_id} 这条任务'
        item.done = True
        return f'已完成 #{item.id}：{item.text}'

    if action == 'clear':
        count = len(_items)
        _items.clear()
        return f'已清空 {count} 条任务'

    if not _items:
        return '（清单为空）'
    return '\n'.join(f"{'[x]' if i.done else '[ ]'} #{i.id} {i.text}" for i in _items)


plugin = define_plugin(
    ToolPlugin(
        name='todo',
        kind='tool',
        description='维护会话内任务清单（add/list/done/clear），多步任务时用来跟踪进度。',
        parameters={
            'type': 'object',
            'properties': {
                'action': {
                    'type': 'string',
                    'enum': ['add', 'list', 'done', 'clear'],
                    'description': '操作',
                },
                'text': {'type': 'string', 'description': 'add 时的任务内容'},
                'id': {'type': 'number', 'description': 'done 时的任务编号'},
            },
            'required': ['action'],
        },
        needs_permission=False,
        preview=_preview,
        run=_run,
    )
)
