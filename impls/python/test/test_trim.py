"""上下文裁剪单测：裁旧留新 + 消息结构（assistant↔tool 配对）不被破坏。"""
from __future__ import annotations

import unittest

from pcode.core.trim import TRIM_PLACEHOLDER, estimate_tokens, trim_context
from pcode.kernel.types import ChatMessage


def exchange(i: int, size: int) -> list[ChatMessage]:
    """构造一组 assistant(tool_call) + tool(大输出) 消息。"""
    return [
        {
            'role': 'assistant',
            'content': None,
            'tool_calls': [
                {'id': f'c{i}', 'type': 'function', 'function': {'name': 'bash', 'arguments': '{}'}}
            ],
        },
        {'role': 'tool', 'tool_call_id': f'c{i}', 'content': 'x' * size},
    ]


class EstimateTokensTest(unittest.TestCase):
    def test_估算随内容增长(self) -> None:
        small: list[ChatMessage] = [{'role': 'user', 'content': 'hi'}]
        big: list[ChatMessage] = [{'role': 'user', 'content': 'x' * 3000}]
        self.assertGreater(estimate_tokens(big), estimate_tokens(small) * 100)


class TrimContextTest(unittest.TestCase):
    def test_不超限时不裁任何内容(self) -> None:
        messages: list[ChatMessage] = [{'role': 'system', 'content': 'sys'}, *exchange(0, 100)]
        self.assertEqual(trim_context(messages, 2**63 - 1).trimmed, 0)

    def test_超限裁剪旧输出变占位最近12条保留配对结构完整(self) -> None:
        messages: list[ChatMessage] = [
            {'role': 'system', 'content': 'sys'},
            {'role': 'user', 'content': 'hi'},
        ]
        for i in range(30):
            messages.extend(exchange(i, 3000))

        result = trim_context(messages, 5000)
        tools = [m for m in messages if m['role'] == 'tool']
        self.assertEqual(result.trimmed, sum(1 for m in tools if m['content'] == TRIM_PLACEHOLDER))
        self.assertEqual(result.trimmed, 18, '30 条工具消息，保留最近 12 条，应裁最旧 18 条')
        self.assertTrue(
            all(m['content'] != TRIM_PLACEHOLDER for m in tools[-12:]),
            '最近 12 条不应被裁',
        )

        # API 合法性：每个 assistant 的 tool_call 后必须紧跟同 id 的 tool 回应
        for i, m in enumerate(messages):
            if m['role'] == 'assistant' and m.get('tool_calls'):
                nxt = messages[i + 1]
                self.assertIsNotNone(nxt)
                for tc in m['tool_calls']:
                    self.assertTrue(
                        nxt['role'] == 'tool' and nxt.get('tool_call_id') == tc['id'],
                        f'消息 {i} 的工具调用 {tc["id"]} 没有紧邻回应',
                    )

    def test_重复裁剪幂等(self) -> None:
        messages: list[ChatMessage] = [{'role': 'system', 'content': 's'}]
        for i in range(20):
            messages.extend(exchange(i, 3000))
        trim_context(messages, 5000)
        self.assertEqual(trim_context(messages, 5000).trimmed, 0, '占位消息不应被二次裁剪')

    def test_空内容工具输出不裁(self) -> None:
        messages: list[ChatMessage] = [
            {'role': 'system', 'content': 'sys'},
            {
                'role': 'assistant',
                'content': None,
                'tool_calls': [
                    {'id': 'e', 'type': 'function', 'function': {'name': 'bash', 'arguments': '{}'}}
                ],
            },
            {'role': 'tool', 'tool_call_id': 'e', 'content': ''},
        ]
        for i in range(30):
            messages.extend(exchange(i, 3000))

        result = trim_context(messages, 5000)
        self.assertEqual(result.trimmed, 18, '只裁 30 条大输出中最旧 18 条，空内容不计')
        self.assertEqual(messages[2]['content'], '', '空内容 tool 消息不应被替换')


if __name__ == '__main__':
    unittest.main()
