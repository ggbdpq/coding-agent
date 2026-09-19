"""edit 工具：精确字符串替换——coding agent 改代码的主力。

old_string 必须在文件中唯一（否则要求补上下文或显式 replace_all），防止误伤。
路径先过守卫：越出工作目录的编辑在权限确认时醒目提示。
白名单免确认（R4）：目标落在 config.allow_write_dirs 内时跳过逐次确认。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pcode.kernel.plugin import ToolPlugin, define_plugin
from pcode.kernel.ui import preview_diff
from pcode.plugins.tools.pathguard import inside_allow_dirs, resolve_path


@dataclass
class EditResult:
    ok: bool
    # ok 时为替换档位（one/all），否则为错误信息
    message: str


def apply_edit(content: str, old_string: str, new_string: str, replace_all: bool) -> EditResult:
    """纯函数，方便单测：在 content 上执行一次精确替换的唯一性判定。"""
    if not old_string:
        return EditResult(ok=False, message='错误：old_string 不能为空')
    count = content.count(old_string)
    if count == 0:
        return EditResult(
            ok=False,
            message='错误：未找到 old_string，请先 read 文件核对精确内容（含缩进与换行）',
        )
    if count > 1 and not replace_all:
        return EditResult(
            ok=False,
            message=(
                f'错误：old_string 出现了 {count} 次。'
                '请加入更多上下文使其唯一；确认要全部替换时设 replace_all=true'
            ),
        )
    return EditResult(ok=True, message='all' if replace_all else 'one')


def _preview(args: dict[str, Any]) -> str:
    outside = resolve_path(str(args.get('file_path') or '')).outside
    flag = '\n⚠ 注意：该路径在当前工作目录之外！' if outside else ''
    return f"编辑 {args.get('file_path')}{flag}\n" + preview_diff(
        str(args.get('old_string') or ''), str(args.get('new_string') or '')
    )


def _run(args: dict[str, Any]) -> str:
    file = str(args.get('file_path') or '')
    old_string = str(args.get('old_string') or '')
    new_string = str(args.get('new_string') or '')
    replace_all = args.get('replace_all') is True
    if not file:
        return '错误：缺少 file_path'
    abs_path = resolve_path(file).abs
    try:
        # newline='' 读写都不转换行符：保留文件原有的 CRLF/LF，未触及部分不动
        with open(abs_path, encoding='utf-8', newline='') as f:
            content = f.read()
    except OSError:
        return f'错误：无法读取 {file}（不存在或不可读）'
    check = apply_edit(content, old_string, new_string, replace_all)
    if not check.ok:
        return check.message
    next_content = (
        content.replace(old_string, new_string)
        if replace_all
        else content.replace(old_string, new_string, 1)
    )
    with open(abs_path, 'w', encoding='utf-8', newline='') as f:
        f.write(next_content)
    count = content.count(old_string) if replace_all else 1
    return f'已替换 {file} 中 {count} 处内容'


plugin = define_plugin(
    ToolPlugin(
        name='edit',
        kind='tool',
        description=(
            '对文件做精确字符串替换：old_string 必须与文件内容完全一致（含缩进）。'
            '多处出现且需全部替换时设 replace_all=true。'
        ),
        parameters={
            'type': 'object',
            'properties': {
                'file_path': {'type': 'string', 'description': '目标文件路径'},
                'old_string': {'type': 'string', 'description': '要被替换的精确原文'},
                'new_string': {'type': 'string', 'description': '替换后的新文本'},
                'replace_all': {'type': 'boolean', 'description': '全部替换，默认 false'},
            },
            'required': ['file_path', 'old_string', 'new_string'],
        },
        needs_permission=True,
        # 白名单免确认：与 write 同规则——目标在 config.allow_write_dirs 内
        skip_permission=lambda args, app: inside_allow_dirs(
            str(args.get('file_path') or ''), app.config.allow_write_dirs
        ),
        preview=_preview,
        run=_run,
    )
)
