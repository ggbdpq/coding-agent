"""核心循环：一轮对话 = 往传入的 messages 数组推进，直到模型不再要工具。

不持有全局状态，方便测试与将来换壳（REPL/TUI/单发）。
注意：按分层规则 loop 不插件化（与 tcode 的 Q4 决策一致）——它是这个项目的灵魂考点，
保持普通导出函数，接口化可替换但不进注册表。
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from pcode.kernel.plugin import ToolDef
from pcode.kernel.registry import to_schemas
from pcode.kernel.types import ChatClient, ChatMessage, ChatOptions

if TYPE_CHECKING:
    from pcode.kernel.app import App

# 防失控：单轮对话最多允许的工具往返次数
MAX_TOOL_ROUNDS = 40


@dataclass
class TurnDeps:
    provider: ChatClient
    tools: list[ToolDef]
    # 白名单免确认（skip_permission）所需的运行环境（config.allow_write_dirs）
    app: App | None = None
    # 权限闸门（needs_permission 的工具会被询问）；缺省视为全部放行
    check: Callable[[str, str], bool] | None = None
    on_text: Callable[[str], None] | None = None
    # token 用量回调（R5）：provider 每解析到一次 usage 就回调 (prompt, completion)
    on_usage: Callable[[int, int], None] | None = None
    # 工具回调带 call_id（turn 层据此发 tool_call/tool_result 事件）
    on_tool_call: Callable[[str, str, dict[str, Any]], None] | None = None
    on_tool_result: Callable[[str, str, str, int], None] | None = None


def run_turn(messages: list[ChatMessage], deps: TurnDeps) -> None:
    schemas = to_schemas(deps.tools)

    for _round in range(MAX_TOOL_ROUNDS):
        opts = ChatOptions(tools=schemas, on_text=deps.on_text, on_usage=deps.on_usage)
        message = deps.provider.chat(messages, opts)['message']
        messages.append(message)
        tool_calls = message.get('tool_calls') or []
        if not tool_calls:
            return

        for call in tool_calls:
            name = call['function']['name']
            args: dict[str, Any] = {}
            try:
                parsed = json.loads(call['function']['arguments'] or '{}')
                if isinstance(parsed, dict):
                    args = parsed
            except json.JSONDecodeError:
                # 参数不是合法 JSON：不在这里报错，落下去让工具名的"错误"文本纠正模型
                pass
            tool = next((t for t in deps.tools if t.name == name), None)
            if tool is None:
                messages.append(
                    {
                        'role': 'tool',
                        'tool_call_id': call['id'],
                        'content': (
                            f'错误：未知工具 {name}。'
                            f"可用工具：{', '.join(t.name for t in deps.tools)}"
                        ),
                    }
                )
                continue
            # Plan Mode（只读规划）：写类工具拒绝执行，引导模型产出计划。
            # 判定在白名单与权限询问之前；getattr 对齐 tcode 的 optional chaining
            # （deps.app?.planMode），测试的最小 App 替身可以不带该字段。
            plan_mode = getattr(deps.app, 'plan_mode', None)
            if plan_mode is not None and plan_mode.value and tool.needs_permission:
                deny_text = (
                    '当前处于 Plan Mode（只读规划）：禁止执行写类操作。'
                    '请继续只读探索，并输出一份分步计划；完成后告知用户用 /plan 切回普通模式执行。'
                )
                messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': deny_text})
                if deps.on_tool_result:
                    deps.on_tool_result(call['id'], tool.name, deny_text, 0)
                continue
            if deps.on_tool_call:
                deps.on_tool_call(call['id'], tool.name, args)

            # 白名单优先（skip_permission 声明受信）→ 闸门逐次确认
            allowed = True
            if tool.needs_permission and deps.check:
                skipped = tool.skip_permission is not None and tool.skip_permission(
                    args, deps.app
                )
                if not skipped:
                    allowed = deps.check(tool.name, tool.preview(args))
            if not allowed:
                messages.append(
                    {
                        'role': 'tool',
                        'tool_call_id': call['id'],
                        'content': '用户拒绝了本次操作。请询问用户怎么办，或换一种方式；不要未经允许重试同样的操作。',
                    }
                )
                if deps.on_tool_result:
                    deps.on_tool_result(call['id'], tool.name, '（用户已拒绝）', 0)
                continue

            started = time.perf_counter()
            try:
                result = tool.run(args)
            except Exception as e:  # 工具错误以"错误：..."文本回给模型，不抛异常
                result = f'错误：{e}'
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': result})
            if deps.on_tool_result:
                deps.on_tool_result(call['id'], tool.name, result, elapsed_ms)

    # 轮次熔断：不带工具再要一次总结，防止无限打转
    message = deps.provider.chat(
        messages, ChatOptions(on_text=deps.on_text, on_usage=deps.on_usage)
    )['message']
    messages.append(message)
