"""/compact：手动触发上下文摘要压缩（自动触发见 core/turn.py 的超限治理）。"""
from __future__ import annotations

from pcode.core.compact import compact_context
from pcode.kernel.app import App
from pcode.kernel.plugin import CommandOutcome, CommandPlugin, define_plugin


def _run(app: App, _args: list[str]) -> CommandOutcome | None:
    try:
        result = compact_context(app)
        print(f'已压缩：替换为任务摘要，节省约 {result.saved_tokens} tokens 的上下文预算。')
    except Exception as e:
        # 错误打印不上抛：压缩失败不该终止会话（历史原封不动，见 core/compact.py）
        print(f'压缩未执行：{e}')
    return None


plugin = define_plugin(
    CommandPlugin(
        name='compact',
        usage='/compact',
        summary='把当前对话压缩成摘要，释放上下文预算',
        run=_run,
    )
)
