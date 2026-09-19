"""上下文预算：粗估 token（不引分词器依赖），超限时从最旧的工具输出裁起。

只动 tool 消息的 content，消息结构不动——assistant/tool_calls 与 tool 回应的
配对关系保持完整，后续请求对 API 依然合法。
"""
from __future__ import annotations

from dataclasses import dataclass

from pcode.kernel.types import ChatMessage

# 保留最近多少条工具消息不动
KEEP_RECENT_TOOLS = 12
# 裁剪占位文本（模型能看懂发生了什么）
TRIM_PLACEHOLDER = '[早期工具输出已省略以释放上下文]'


@dataclass
class TrimResult:
    trimmed: int


def estimate_tokens(messages: list[ChatMessage]) -> int:
    """粗估 token：按 3 字符 ≈ 1 token 折中（英文约 4 字符/词、中文更密），另计每条固定开销。"""
    chars = 0
    for m in messages:
        content = m.get('content')
        chars += (len(content) if content else 0) + 8
        for tc in m.get('tool_calls') or []:
            chars += len(tc['function']['name']) + len(tc['function']['arguments']) + 8
    return (chars + 2) // 3


def trim_context(messages: list[ChatMessage], limit: int) -> TrimResult:
    """就地裁剪，返回被裁的消息条数；保留最近 KEEP_RECENT_TOOLS 条工具输出，裁完仍超限就到顶。"""
    if estimate_tokens(messages) <= limit:
        return TrimResult(trimmed=0)
    tool_indexes = [i for i, m in enumerate(messages) if m['role'] == 'tool']
    candidates = tool_indexes[: max(0, len(tool_indexes) - KEEP_RECENT_TOOLS)]
    trimmed = 0
    for i in candidates:
        if estimate_tokens(messages) <= limit:
            break
        m = messages[i]
        content = m.get('content')
        if content and content != TRIM_PLACEHOLDER:
            m['content'] = TRIM_PLACEHOLDER
            trimmed += 1
    return TrimResult(trimmed=trimmed)
