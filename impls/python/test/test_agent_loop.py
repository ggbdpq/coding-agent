"""工具循环单测：40 轮熔断（带工具请求次数口径、熔断后不带工具强制总结）
+ 工具异常折叠为「错误：」文本回流不中断本轮（镜像 typescript/test/loop.test.ts）。
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from typing import Any

from pcode.core.turn import TurnHooks, run_user_turn
from pcode.kernel.plugin import ToolPlugin, define_plugin
from pcode.kernel.registry import Registry
from pcode.kernel.types import AgentEvent, ChatMessage, CompletionResult, YoloRef


def _tool_call(name: str, call_id: str) -> ChatMessage:
    return {
        'role': 'assistant',
        'content': None,
        'tool_calls': [
            {'id': call_id, 'type': 'function', 'function': {'name': name, 'arguments': '{}'}}
        ],
    }


fake_tool = define_plugin(
    ToolPlugin(
        name='fake',
        description='',
        parameters={'type': 'object', 'properties': {}},
        needs_permission=False,
        preview=lambda args: '',
        run=lambda args: '工具结果',
    )
)


def _boom_run(args: dict[str, Any]) -> str:
    raise RuntimeError('炸了')


boom_tool = define_plugin(
    ToolPlugin(
        name='boom',
        description='',
        parameters={'type': 'object', 'properties': {}},
        needs_permission=False,
        preview=lambda args: '',
        run=_boom_run,
    )
)


def fake_app(client: Any, tools: list[Any]) -> SimpleNamespace:
    registry = Registry()
    for t in tools:
        registry = registry.register(t)
    return SimpleNamespace(
        config=SimpleNamespace(context_limit=1_000_000),
        registry=registry,
        provider=client,
        store=SimpleNamespace(append=lambda m: None),
        yolo=YoloRef(value=True),
        plan_mode=YoloRef(value=False),
        messages=[],
    )


class _AlwaysToolCallClient:
    """每次都要求同一个工具调用，永不主动收尾。"""

    def __init__(self) -> None:
        self.n = 0

    def chat(self, messages: list[ChatMessage], opts: Any = None) -> CompletionResult:
        self.n += 1
        if self.n <= 40:
            return {'message': _tool_call('fake', f'c{self.n}')}
        if opts is not None and opts.on_text:
            opts.on_text('总结')
        return {'message': {'role': 'assistant', 'content': '总结'}}


class _BoomThenDoneClient:
    """第 1 轮要 boom（必抛错），第 2 轮出最终回答。"""

    def __init__(self) -> None:
        self.n = 0

    def chat(self, messages: list[ChatMessage], opts: Any = None) -> CompletionResult:
        self.n += 1
        if self.n == 1:
            return {'message': _tool_call('boom', 'c1')}
        return {'message': {'role': 'assistant', 'content': '完成'}}


class LoopTest(unittest.TestCase):
    def test_熔断_恰40次带工具请求加1次无工具强制总结(self) -> None:
        client = _AlwaysToolCallClient()
        app = fake_app(client, [fake_tool])
        events: list[AgentEvent] = []
        run_user_turn(app, '做事', TurnHooks(emit=events.append))

        self.assertEqual(client.n, 41, '40 轮带工具请求 + 1 次无工具总结')
        self.assertEqual(len(app.messages), 82, 'user + 40×(assistant+tool) + 总结')
        end = events[-1]
        self.assertEqual(end.type, 'turn_end')
        self.assertEqual(end.reason, 'completed')

    def test_工具抛错折叠为错误文本回流不中断本轮(self) -> None:
        app = fake_app(_BoomThenDoneClient(), [boom_tool])
        events: list[AgentEvent] = []
        run_user_turn(app, '做事', TurnHooks(emit=events.append))

        tool_msg = next(m for m in app.messages if m['role'] == 'tool')
        self.assertTrue(str(tool_msg['content']).startswith('错误：'), '错误应折叠为工具结果文本')
        end = events[-1]
        self.assertEqual(end.reason, 'completed', '工具错误不中断本轮')


if __name__ == '__main__':
    unittest.main()
