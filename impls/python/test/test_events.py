"""事件模型单测：turn 的规范事件序列（AgentEvent）是壳/审计/回放的公共契约。

镜像 tcode test/events.test.ts 的 Python 版，按同步模型适配一处：
异常路径（KeyboardInterrupt / 普通错误）不发 turn_end——先断尾修复、落盘，再上抛
（展示方式是壳的事，与 tcode 发 turn_end(aborted/error) 的差异见 README 已知局限）。
锁死三件事：事件类型与顺序、turn_end 终态原因、断尾修复与事件的互不干扰。
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
    """假会话存储：只记录 append 调用。"""

    def __init__(self) -> None:
        self.appended: list[ChatMessage] = []

    def append(self, m: ChatMessage) -> None:
        self.appended.append(m)


def _tool_call_message() -> ChatMessage:
    return {
        'role': 'assistant',
        'content': None,
        'tool_calls': [
            {'id': 'c1', 'type': 'function', 'function': {'name': 'fake', 'arguments': '{}'}}
        ],
    }


class _ToolThenTextClient:
    """要工具→拿到结果→出最终回答 的两段式假客户端。"""

    def chat(self, messages: list[ChatMessage], opts: Any = None) -> CompletionResult:
        if not any(m['role'] == 'tool' for m in messages):
            return {'message': _tool_call_message()}
        if opts is not None and opts.on_text:
            opts.on_text('完成')
        return {'message': {'role': 'assistant', 'content': '完成'}}


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


def fake_app(provider: Any, store: _FakeStore | None = None) -> SimpleNamespace:
    """run_user_turn 只认 App 的五个成员，测试用最小替身（与 tcode 同法）。"""
    return SimpleNamespace(
        config=SimpleNamespace(context_limit=1_000_000),
        registry=Registry().register(fake_tool),
        provider=provider,
        store=store if store is not None else _FakeStore(),
        yolo=YoloRef(value=True),
        messages=[],
    )


class EventSequenceTest(unittest.TestCase):
    def test_规范序列_turn_start到turn_end_completed(self) -> None:
        store = _FakeStore()
        app = fake_app(_ToolThenTextClient(), store)
        events: list[AgentEvent] = []
        run_user_turn(app, '做事', TurnHooks(emit=events.append))

        self.assertEqual(
            [e.type for e in events],
            ['turn_start', 'user', 'tool_call', 'tool_result', 'text_delta', 'turn_end'],
        )
        start = events[0]
        self.assertEqual(start.type, 'turn_start')
        self.assertIsInstance(start.id, str)
        self.assertTrue(start.id)
        call = next(e for e in events if e.type == 'tool_call')
        self.assertEqual(call.call_id, 'c1')
        self.assertEqual(call.name, 'fake')
        self.assertEqual(call.args, {})
        result = next(e for e in events if e.type == 'tool_result')
        self.assertEqual(result.summary, '工具结果')
        self.assertIsInstance(result.ms, int)
        end = events[-1]
        self.assertEqual(end.type, 'turn_end')
        self.assertEqual(end.reason, 'completed')
        # 会话落盘与事件不冲突：user + assistant + tool + assistant 四条
        self.assertEqual(len(store.appended), 4)


class InterruptPathTest(unittest.TestCase):
    def test_工具已执行后中断_结果仍在落盘序列且不发turn_end(self) -> None:
        first = True
        store = _FakeStore()

        class _InterruptAfterTool:
            def chat(self, messages: list[ChatMessage], opts: Any = None) -> CompletionResult:
                nonlocal first
                if first:
                    first = False
                    return {'message': _tool_call_message()}
                raise KeyboardInterrupt()

        app = fake_app(_InterruptAfterTool(), store)
        events: list[AgentEvent] = []
        with self.assertRaises(KeyboardInterrupt):
            run_user_turn(app, '做事', TurnHooks(emit=events.append))

        # user → assistant(tool_call) → tool(真实结果)，无悬空调用
        self.assertEqual([m['role'] for m in app.messages], ['user', 'assistant', 'tool'])
        self.assertEqual(app.messages[-1]['content'], '工具结果')
        self.assertGreaterEqual(len(store.appended), 3, '断尾修复后的消息也应落盘')
        self.assertNotIn('turn_end', [e.type for e in events])

    def test_工具执行中中断_断尾补占位再落盘上抛(self) -> None:
        store = _FakeStore()

        class _InterruptInTool:
            def run(self, args: dict[str, Any]) -> str:
                raise KeyboardInterrupt()

        tool = define_plugin(
            ToolPlugin(
                name='fake',
                description='',
                parameters={'type': 'object', 'properties': {}},
                needs_permission=False,
                preview=lambda args: '',
                run=_InterruptInTool().run,
            )
        )
        app = fake_app(_ToolThenTextClient())
        app.registry = Registry().register(tool)
        app.store = store
        events: list[AgentEvent] = []
        with self.assertRaises(KeyboardInterrupt):
            run_user_turn(app, '做事', TurnHooks(emit=events.append))

        # "有工具调用、无回应"的断尾被补占位，消息序列对 API 合法
        self.assertEqual([m['role'] for m in app.messages], ['user', 'assistant', 'tool'])
        self.assertEqual(app.messages[-1]['content'], '（用户中止，未执行）')
        self.assertEqual(app.messages[-1]['tool_call_id'], 'c1')
        self.assertGreaterEqual(len(store.appended), 3)
        self.assertNotIn('turn_end', [e.type for e in events])

    def test_普通错误同样断尾修复落盘且不发turn_end(self) -> None:
        class _Broken:
            def chat(self, messages: list[ChatMessage], opts: Any = None) -> CompletionResult:
                raise RuntimeError('网络炸了')

        store = _FakeStore()
        app = fake_app(_Broken(), store)
        events: list[AgentEvent] = []
        with self.assertRaisesRegex(RuntimeError, '网络炸了'):
            run_user_turn(app, '做事', TurnHooks(emit=events.append))

        self.assertEqual([m['role'] for m in app.messages], ['user'])
        self.assertEqual(len(store.appended), 1, '异常路径仍要落盘已入列的消息')
        self.assertEqual([e.type for e in events], ['turn_start', 'user'])


if __name__ == '__main__':
    unittest.main()
