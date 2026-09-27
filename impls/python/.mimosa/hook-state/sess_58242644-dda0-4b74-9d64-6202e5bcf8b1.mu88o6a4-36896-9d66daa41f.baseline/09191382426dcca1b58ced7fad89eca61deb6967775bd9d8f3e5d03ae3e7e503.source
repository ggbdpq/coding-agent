"""compact 单测：摘要替换历史、失败永不破坏会话（镜像 tcode test/compact.test.ts）。

同步模型适配：中止即 KeyboardInterrupt 穿透，原历史同样原封不动。
"""
from __future__ import annotations

import copy
import unittest
from types import SimpleNamespace
from typing import Any

from pcode.core.compact import compact_context
from pcode.kernel.types import ChatMessage, CompletionResult


class _Summarizer:
    def chat(self, messages: list[ChatMessage], opts: Any = None) -> CompletionResult:
        return {'message': {'role': 'assistant', 'content': '这是摘要'}}


def fake_app(provider: Any, messages: list[ChatMessage]) -> SimpleNamespace:
    """compact_context 只认 App 的两个成员，测试用最小替身（与 tcode 同法）。"""
    return SimpleNamespace(provider=provider, messages=messages)


def history_messages() -> list[ChatMessage]:
    msgs: list[ChatMessage] = [{'role': 'system', 'content': '系统提示'}]
    for i in range(10):
        msgs.append({'role': 'user', 'content': f'问题 {i}'})
        msgs.append({'role': 'assistant', 'content': f'回答 {i}'})
    return msgs


class CompactContextTest(unittest.TestCase):
    def test_历史替换为摘要并返回节省token数(self) -> None:
        messages = history_messages()
        app = fake_app(_Summarizer(), messages)
        before = len(app.messages)

        result = compact_context(app, signal=None)

        # v0.4 起：摘要之外保留最近 4 条原文（断言随行为升级，详细断言见 test_compact_tail.py）
        self.assertGreater(result.saved_tokens, 0)
        self.assertEqual(len(app.messages), 6, 'system + 摘要 + 最近 4 条原文')
        self.assertEqual(app.messages[0]['role'], 'system')
        self.assertEqual(app.messages[0]['content'], '系统提示')
        content = app.messages[1]['content'] or ''
        self.assertIn('这是摘要', content)
        self.assertIn('[此前对话的摘要', content)
        self.assertIn('[摘要结束]', content)
        self.assertEqual(app.messages[2], messages[-4], '尾部从 user 边界开始')
        self.assertEqual(app.messages[2:], messages[-4:])
        self.assertGreater(before, len(app.messages))

    def test_历史太短5条以内拒绝并保持原状(self) -> None:
        messages: list[ChatMessage] = [
            {'role': 'system', 'content': 's'},
            {'role': 'user', 'content': 'a'},
            {'role': 'assistant', 'content': 'b'},
            {'role': 'user', 'content': 'c'},
            {'role': 'assistant', 'content': 'd'},
        ]
        app = fake_app(_Summarizer(), messages)
        with self.assertRaisesRegex(ValueError, '没什么可压缩'):
            compact_context(app)
        self.assertEqual(len(app.messages), 5)

    def test_摘要失败原历史原封不动(self) -> None:
        class _Broken:
            def chat(self, messages: list[ChatMessage], opts: Any = None) -> CompletionResult:
                raise RuntimeError('网络炸了')

        messages = history_messages()
        snapshot = copy.deepcopy(messages)
        app = fake_app(_Broken(), messages)
        with self.assertRaisesRegex(RuntimeError, '网络炸了'):
            compact_context(app)
        self.assertEqual(app.messages, snapshot)

    def test_用户中止原历史原封不动(self) -> None:
        class _Interrupt:
            def chat(self, messages: list[ChatMessage], opts: Any = None) -> CompletionResult:
                raise KeyboardInterrupt()

        messages = history_messages()
        app = fake_app(_Interrupt(), messages)
        with self.assertRaises(KeyboardInterrupt):
            compact_context(app)
        self.assertEqual(len(app.messages), 21)


if __name__ == '__main__':
    unittest.main()
