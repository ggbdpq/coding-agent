"""apply_patch 工具：多文件原子编辑——先对全部编辑做预验（每条 old_string 必须在其

文件中唯一存在），任一失败则整体不应用并逐条报告；全部通过后才写入。
原子性说明：预验与写入之间无并发写者（pcode 工具循环串行），因此"全预验→全写入"
即实际原子；安全边界：逐次确认，preview 列出全部目标文件。
白名单不豁免本工具（无 skip_permission）——跨文件批量改动始终逐次确认，与 tcode 一致。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pcode.kernel.plugin import ToolPlugin, define_plugin
from pcode.plugins.tools.pathguard import resolve_path


@dataclass
class PreparedEdit:
    """一条通过预验的编辑：abs 写入路径、display 展示名、original 缓存原文、next 替换后文本。"""

    abs: str
    display: str
    original: str
    next: str


def _preview(args: dict[str, Any]) -> str:
    edits = args.get('edits')
    if not isinstance(edits, list):
        edits = []
    # 去重保持首次出现顺序
    files = list(dict.fromkeys(str(e.get('file_path')) for e in edits if isinstance(e, dict)))
    rows = '\n'.join(f'  · {f}' for f in files)
    return f'原子补丁：{len(edits)} 处编辑，涉及 {len(files)} 个文件\n{rows}'


def _run(args: dict[str, Any]) -> str:
    raw = args.get('edits')
    if not isinstance(raw, list):
        raw = []
    if not raw:
        return '错误：edits 不能为空'

    # 第一阶段：全量预验（读文件 + 唯一性检查），不改任何磁盘内容
    cache: dict[str, str] = {}
    prepared: list[PreparedEdit] = []
    errors: list[str] = []
    for i, item in enumerate(raw):
        e = item if isinstance(item, dict) else {}
        file = str(e.get('file_path') or '')
        old_string = str(e.get('old_string') or '')
        new_string = str(e.get('new_string') or '')
        replace_all = e.get('replace_all') is True
        if not file or not old_string:
            errors.append(f'#{i}：缺少 file_path 或 old_string')
            continue
        original = cache.get(file)
        if original is None:
            try:
                # newline='' 读写都不转换行符：保留文件原有的 CRLF/LF（与 edit/write 同规则）
                with open(resolve_path(file).abs, encoding='utf-8', newline='') as f:
                    original = f.read()
            except OSError:
                errors.append(f'#{i}：无法读取 {file}')
                continue
            cache[file] = original
        count = original.count(old_string)
        if count == 0:
            errors.append(f'#{i}：{file} 中未找到 old_string')
            continue
        if count > 1 and not replace_all:
            errors.append(f'#{i}：{file} 中 old_string 出现 {count} 次（需 replace_all 或更多上下文）')
            continue
        next_content = (
            original.replace(old_string, new_string)
            if replace_all and count > 1
            else original.replace(old_string, new_string, 1)
        )
        prepared.append(
            PreparedEdit(
                abs=resolve_path(file).abs, display=file, original=original, next=next_content
            )
        )
    if errors:
        return '错误：预验未通过，未写入任何文件。\n' + '\n'.join(f'- {s}' for s in errors)

    # 第二阶段：全部通过，按 prepared 顺序逐条写入
    # （同一文件多条编辑时各 next 都基于同一份缓存原文、后写覆盖前写——与 tcode 一致，勿"修复"）
    for p in prepared:
        with open(p.abs, 'w', encoding='utf-8', newline='') as f:
            f.write(p.next)
    return f'已应用补丁：{len(prepared)} 处编辑，涉及 {len({p.display for p in prepared})} 个文件'


plugin = define_plugin(
    ToolPlugin(
        name='apply_patch',
        kind='tool',
        description=(
            '对多个文件一次应用多处精确替换（原子操作：全部预验通过才写入，任一失败整体放弃）。'
            '适合跨文件的重命名/批量调整；单文件小改动仍优先用 edit。'
        ),
        parameters={
            'type': 'object',
            'properties': {
                'edits': {
                    'type': 'array',
                    'description': '编辑列表，每项 {file_path, old_string, new_string, replace_all?}',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'file_path': {'type': 'string'},
                            'old_string': {'type': 'string'},
                            'new_string': {'type': 'string'},
                            'replace_all': {'type': 'boolean'},
                        },
                        'required': ['file_path', 'old_string', 'new_string'],
                    },
                },
            },
            'required': ['edits'],
        },
        needs_permission=True,
        preview=_preview,
        run=_run,
    )
)
