"""一轮用户输入的完整编排：裁剪 → 入列 → 工具循环 → 断尾修复 → 会话落盘。

REPL 与将来的其他壳共用这里，保证裁剪/落盘/修复语义全项目只有一份。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from pcode.core.agent_loop import TurnDeps, run_turn
from pcode.core.trim import trim_context
from pcode.kernel.app import App


@dataclass
class TurnHooks:
    # 权限闸门（needs_permission 的工具会被询问）；缺省视为全部放行
    check: Callable[[str, str], bool] | None = None
    on_text: Callable[[str], None] | None = None
    on_tool_call: Callable[[str, dict[str, Any]], None] | None = None
    on_tool_result: Callable[[str, str, int], None] | None = None
    # 上下文被裁剪时通知壳（REPL 打灰字）
    on_trimmed: Callable[[int], None] | None = None


def run_user_turn(app: App, line: str, hooks: TurnHooks | None = None) -> None:
    effective = hooks or TurnHooks()
    # 轮前裁剪：只影响发给模型的上下文；会话文件里保留完整历史
    cut = trim_context(app.messages, app.config.context_limit)
    if cut.trimmed > 0 and effective.on_trimmed:
        effective.on_trimmed(cut.trimmed)

    app.messages.append({'role': 'user', 'content': line})
    mark = len(app.messages) - 1

    def append_since() -> None:
        for m in app.messages[mark:]:
            app.store.append(m)

    try:
        run_turn(
            app.messages,
            TurnDeps(
                provider=app.provider,
                tools=app.registry.tools(),
                check=effective.check,
                on_text=effective.on_text,
                on_tool_call=effective.on_tool_call,
                on_tool_result=effective.on_tool_result,
            ),
        )
    except BaseException:
        # 中断可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法。
        # 同步模型里 Ctrl+C（KeyboardInterrupt）也走这里：先修复并落盘，再上抛给壳处理。
        last = app.messages[-1] if app.messages else None
        if last is not None and last.get('role') == 'assistant' and last.get('tool_calls'):
            answered = {
                m.get('tool_call_id') for m in app.messages if m.get('role') == 'tool'
            }
            for tc in last['tool_calls']:
                if tc['id'] not in answered:
                    app.messages.append(
                        {
                            'role': 'tool',
                            'tool_call_id': tc['id'],
                            'content': '（用户中止，未执行）',
                        }
                    )
        append_since()
        raise  # 展示方式是壳的事：REPL 区分中止/出错
    append_since()
