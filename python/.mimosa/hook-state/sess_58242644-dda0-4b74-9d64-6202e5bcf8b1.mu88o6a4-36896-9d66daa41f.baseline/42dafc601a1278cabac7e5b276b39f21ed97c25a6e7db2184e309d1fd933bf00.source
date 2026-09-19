"""Plan Mode 单测：开启时写类工具被拒（引导产出计划）、读类不受影响、关闭恢复。

镜像 tcode test/planmode.test.ts，按 pcode 惯例用假 app/假 provider/事件收集
（参照 test_events.py 的写法）。
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from typing import Any

from pcode.core.turn import TurnHooks, run_user_turn
from pcode.kernel.plugin import ToolPlugin, define_plugin
from pcode.kernel.registry import Registry
from pcode.kernel.types import AgentEvent, ChatMessage, CompletionResult, YoloRef


class _FakeStore:
    def append(self, m: ChatMessage) -> None:
        pass


def _tool_call(name: str, call_id: str) -> ChatMessage:
    return {
        'role': 'assistant',
        'content': None,
        'tool_calls': [
            {'id': call_id, 'type': 'function', 'function': {'name': name, 'arguments': '{}'}}
        ],
    }


class _WriteThenReadClient:
    """第 1 轮要 write，第 2 轮要 read，第 3 轮出最终回答。"""

    def __init__(self) -> None:
        self.n = 0

    def chat(self, messages: list[ChatMessage], opts: Any = None) -> CompletionResult:
        self.n += 1
        if self.n == 1:
            return {'message': _tool_call('write', 'c1')}
        if self.n == 2:
            return {'message': _tool_call('read', 'c2')}
        if opts is not None and opts.on_text:
            opts.on_text('完成')
        return {'message': {'role': 'assistant', 'content': '完成'}}


write_tool = define_plugin(
    ToolPlugin(
        name='write',
        description='',
        parameters={'type': 'object', 'properties': {}},
        needs_permission=True,
        preview=lambda args: '',
        run=lambda args: '已写入',
    )
)

read_tool = define_plugin(
    ToolPlugin(
        name='read',
        description='',
        parameters={'type': 'object', 'properties': {}},
        needs_permission=False,
        preview=lambda args: '',
        run=lambda args: '文件内容',
    )
)


def fake_app(plan_on: bool, provider: Any) -> SimpleNamespace:
    """run_user_turn 只认 App 的少数成员，测试用最小替身（与 test_events 同法）。"""
    return SimpleNamespace(
        config=SimpleNamespace(context_limit=1_000_000),
        registry=Registry().register(write_tool).register(read_tool),
        provider=provider,
        store=_FakeStore(),
        yolo=YoloRef(value=True),
        plan_mode=YoloRef(value=plan_on),
        messages=[],
    )


class PlanModeTest(unittest.TestCase):
    def test_开启时写类被拒并引导产出计划_读类正常(self) -> None:
        app = fake_app(True, _WriteThenReadClient())
        events: list[AgentEvent] = []
        run_user_turn(app, '做个计划', TurnHooks(emit=events.append))

        results = [e for e in events if e.type == 'tool_result']
        self.assertGreaterEqual(len(results), 2, '应有两次工具回合')
        write_denied = next(r for r in results if r.name == 'write')
        self.assertIn('Plan Mode', write_denied.summary, 'write 应被 Plan Mode 拒绝')
        read_ok = next(r for r in results if r.name == 'read')
        self.assertIn('文件内容', read_ok.summary, 'read 不受影响')

    def test_关闭时写类正常执行(self) -> None:
        app = fake_app(False, _WriteThenReadClient())
        events: list[AgentEvent] = []
        run_user_turn(app, '直接写', TurnHooks(emit=events.append))

        write_result = next(r for r in events if r.type == 'tool_result' and r.name == 'write')
        self.assertIn('已写入', write_result.summary)


if __name__ == '__main__':
    unittest.main()
