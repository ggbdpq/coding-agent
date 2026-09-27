"""compact 尾部保留单测（v0.4-1）：摘要之外保留最近 4 条原文，切片点配对安全。

镜像 tcode test/compact.test.ts 的新断言：
- 尾部恰好 4 条且与原末尾一致；
- 理想切点（len-4）落在 tool 消息上时，从 len-4 起向序列前方扫描最近一条 user
  作为 tail_start（找不到则不保留尾巴）——tool 回应永不与它的 assistant 调用分离。
"""

import unittest
from types import SimpleNamespace
from typing import Any

from pcode.core.compact import compact_context
from pcode.kernel.types import ChatMessage, CompletionResult


class _Summarizer:
    def chat(self, messages: list[ChatMessage], opts: Any = None) -> CompletionResult:
        return {'message': {'role': 'assistant', 'content': '这是摘要'}}


def fake_app(provider: Any, messages: list[ChatMessage]) -> SimpleNamespace:
    """compact_context 只认 App 的 provider/messages 两个成员，测试用最小替身。"""
    return SimpleNamespace(provider=provider, messages=messages)


def history_messages() -> list[ChatMessage]:
    msgs: list[ChatMessage] = [{'role': 'system', 'content': '系统提示'}]
    for i in range(10):
        msgs.append({'role': 'user', 'content': f'问题 {i}'})
        msgs.append({'role': 'assistant', 'content': f'回答 {i}'})
    return msgs


class CompactTailTest(unittest.TestCase):
    def test_摘要加保留最近4条原文且返回节省token数(self) -> None:
        messages = history_messages()
        app = fake_app(_Summarizer(), messages)
        before = len(messages)

        result = compact_context(app)

        self.assertGreater(result.saved_tokens, 0)
        self.assertEqual(len(app.messages), 6, 'system + 摘要 + 最近 4 条原文')
        self.assertEqual(app.messages[0]['role'], 'system')
        self.assertEqual(app.messages[0]['content'], '系统提示')
        self.assertIn('这是摘要', app.messages[1]['content'] or '')
        # 尾部从 user 边界开始，内容与原末尾一致
        self.assertEqual(app.messages[2]['role'], 'user')
        self.assertEqual(app.messages[2:], messages[-4:])
        self.assertGreater(before, len(app.messages))

    def test_配对安全切片_理想切点落在tool消息上时扫描到user(self) -> None:
        # 构造理想切点（len-4=6）恰为 tool 消息的历史：
        # 0 system,1 user,2 assistant(tc),3 tool,4 user,5 assistant(tc),6 tool,7 user,8 assistant,9 user
        messages: list[ChatMessage] = [
            {'role': 'system', 'content': '系统提示'},
            {'role': 'user', 'content': 'u1'},
            {
                'role': 'assistant',
                'content': None,
                'tool_calls': [
                    {'id': 'c1', 'type': 'function', 'function': {'name': 'bash', 'arguments': '{}'}}
                ],
            },
            {'role': 'tool', 'tool_call_id': 'c1', 'content': 'r1'},
            {'role': 'user', 'content': 'u2'},
            {
                'role': 'assistant',
                'content': None,
                'tool_calls': [
                    {'id': 'c2', 'type': 'function', 'function': {'name': 'bash', 'arguments': '{}'}}
                ],
            },
            {'role': 'tool', 'tool_call_id': 'c2', 'content': 'r2'},
            {'role': 'user', 'content': 'u3'},
            {'role': 'assistant', 'content': 'a3'},
            {'role': 'user', 'content': 'u4'},
        ]
        app = fake_app(_Summarizer(), messages)

        compact_context(app)

        # tail 从 idx7（user）开始：len-4=6 的 tool 不作切点 → system + 摘要 + 3 条尾部
        self.assertEqual(len(app.messages), 5)
        self.assertEqual(app.messages[2]['content'], 'u3')
        # 摘要区已展平，无悬空 tool 回应
        self.assertTrue(all(m['role'] != 'tool' for m in app.messages))

    def test_尾部找不到user边界时不保留尾巴(self) -> None:
        # 从 len-4 起全是 assistant/tool 的极端历史：tail_start=len → 只留 system+摘要
        messages: list[ChatMessage] = [
            {'role': 'system', 'content': '系统提示'},
            {'role': 'user', 'content': 'u1'},
            {
                'role': 'assistant',
                'content': None,
                'tool_calls': [
                    {'id': 'c1', 'type': 'function', 'function': {'name': 'bash', 'arguments': '{}'}}
                ],
            },
            {'role': 'tool', 'tool_call_id': 'c1', 'content': 'r1'},
            {
                'role': 'assistant',
                'content': None,
                'tool_calls': [
                    {'id': 'c2', 'type': 'function', 'function': {'name': 'bash', 'arguments': '{}'}}
                ],
            },
            {'role': 'tool', 'tool_call_id': 'c2', 'content': 'r2'},
        ]
        app = fake_app(_Summarizer(), messages)

        compact_context(app)

        self.assertEqual(len(app.messages), 2, 'system + 摘要，无尾部')
        self.assertIn('这是摘要', app.messages[1]['content'] or '')


if __name__ == '__main__':
    unittest.main()
