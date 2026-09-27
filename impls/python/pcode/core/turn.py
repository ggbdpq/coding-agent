"""一轮用户输入的完整编排：治理（compact/trim）→ 入列 → 工具循环 → 断尾修复 → 会话落盘。

REPL 与将来的其他壳共用这里，保证治理/落盘/修复语义全项目只有一份。
R1 事件模型：turn 是唯一生产者，通过 emit 发出规范 AgentEvent（kernel/types），
壳只订阅不拼装——加功能=加事件类型，不动消费端接口。
"""
from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4
from typing import Callable

from pcode.core.agent_loop import TurnDeps, run_turn
from pcode.core.compact import compact_context
from pcode.core.trim import estimate_tokens, trim_context
from pcode.kernel.app import App
from pcode.kernel.types import (
    AgentEvent,
    Compact,
    TextDelta,
    ToolCallEvent,
    ToolResult,
    Trimmed,
    TurnEnd,
    TurnStart,
    Usage,
    User,
)


@dataclass
class TurnHooks:
    # 规范事件出口：壳渲染（REPL 直写）、审计与测试断言都消费它
    emit: Callable[[AgentEvent], None]
    # 权限闸门（needs_permission 的工具会被询问）；缺省视为全部放行
    check: Callable[[str, str], bool] | None = None


def run_user_turn(app: App, line: str, hooks: TurnHooks) -> None:
    emit = hooks.emit

    # 轮前上下文治理（v0.4-1 双档）：估算超预算 80% 先试摘要压缩（保留任务目标与
    # 最近原文，发 compact 事件），仍超限再退裁剪（丢最旧工具输出兜底，发 trimmed）。
    # compact 只捕 Exception：KeyboardInterrupt 不降级，直接穿透（用户要退出就退出）。
    if estimate_tokens(app.messages) > app.config.context_limit * 0.8:
        try:
            result = compact_context(app)
            emit(Compact(saved_tokens=result.saved_tokens))
        except Exception:
            cut = trim_context(app.messages, app.config.context_limit)
            if cut.trimmed > 0:
                emit(Trimmed(count=cut.trimmed))

    emit(TurnStart(id=str(uuid4())))
    emit(User(text=line))

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
                # 白名单免确认（skip_permission）需要 config.allow_write_dirs
                app=app,
                check=hooks.check,
                on_text=lambda delta: emit(TextDelta(delta=delta)),
                # R5：provider 解析到的 token 用量转成规范事件
                on_usage=lambda prompt, completion: emit(
                    Usage(prompt_tokens=prompt, completion_tokens=completion)
                ),
                on_tool_call=lambda call_id, name, args: emit(
                    ToolCallEvent(call_id=call_id, name=name, args=args)
                ),
                on_tool_result=lambda call_id, name, result, ms: emit(
                    ToolResult(
                        call_id=call_id,
                        name=name,
                        summary=result.split('\n')[0],
                        ms=ms,
                    )
                ),
            ),
        )
    except BaseException as e:
        # 中断可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法。
        # 同步模型里 Ctrl+C（KeyboardInterrupt）也走这里：先修复并落盘，再上抛给壳处理。
        # 终态事件与 tcode/go/csharp 对齐：KeyboardInterrupt=aborted，其余=error；
        # 每轮恰发一个 turn_end，发完仍上抛（展示方式是壳的事）。
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
        if isinstance(e, KeyboardInterrupt):
            emit(TurnEnd(reason='aborted'))
        else:
            emit(TurnEnd(reason='error', error=str(e)))
        raise
    append_since()
    emit(TurnEnd(reason='completed'))
