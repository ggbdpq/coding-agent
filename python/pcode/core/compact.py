"""上下文压缩（R3，v0.4 打磨，对齐 tcode core/compact.ts）：调当前模型把旧对话压成
摘要，历史替换为 [system, 摘要消息, 最近 4 条原文]。trim（裁旧丢历史）降级为
compact 失败时的兜底。

纪律：摘要失败/中止时原 messages 原封不动——compact 永不破坏会话。
同步模型适配：没有可轮询的 AbortSignal，用户中止即 KeyboardInterrupt 直接穿透，
同样落在"成功才动历史"的保护之下；signal 参数仅占位以对齐 tcode 的签名形状。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pcode.core.trim import estimate_tokens
from pcode.kernel.app import App
from pcode.kernel.types import ChatMessage

MIN_MESSAGES = 5  # system + 至少 4 条对话才值得压缩
TAIL_KEEP = 4  # 摘要之外保留最近多少条原文（任务细节不丢）
SUMMARY_PROMPT = (
    '请把下面的对话历史压缩成一份简洁的任务摘要，供后续工作参考。'
    '必须保留：当前任务目标、已完成的关键步骤、重要文件路径与结论、尚未完成的事项。'
    '直接输出摘要正文，不要客套。'
)


@dataclass
class CompactResult:
    """压缩前后估算 token 之差（>0 即省下的预算）。"""

    saved_tokens: int


def _pick_tail_start(messages: list[ChatMessage], ideal_start: int) -> int:
    """尾部起点必须落在 user 消息上（配对安全：tool 回应不与 assistant 调用分离）。

    从 ideal_start 起向序列前方扫描最近一条 user；找不到 user 边界 → 返回 len，
    即不保留尾巴（与 tcode pickTailStart 同法）。
    """
    for i in range(max(1, ideal_start), len(messages)):
        if messages[i].get('role') == 'user':
            return i
    return len(messages)


def compact_context(app: App, *, signal: Any = None) -> CompactResult:
    """把 app.messages 压成 [system, 摘要, 最近 TAIL_KEEP 条原文]；失败/中止抛异常且历史不动。"""
    messages = app.messages
    if len(messages) <= MIN_MESSAGES:
        raise ValueError('对话太短，没什么可压缩的')
    before = estimate_tokens(messages)

    transcript = '\n'.join(_transcript_line(m) for m in messages[1:])
    summary = app.provider.chat(
        [
            {'role': 'system', 'content': '你是会话摘要器：只输出摘要正文，用简体中文，尽量精炼。'},
            {'role': 'user', 'content': f'{SUMMARY_PROMPT}\n\n--- 对话历史 ---\n{transcript}'},
        ]
    )['message'].get('content')
    if not summary:
        raise ValueError('模型返回了空摘要')

    # 成功才动历史：system + 摘要（纯 user 文本）+ 最近原文（切片点配对安全）
    tail_start = _pick_tail_start(messages, max(1, len(messages) - TAIL_KEEP))
    summary_msg: ChatMessage = {
        'role': 'user',
        'content': f'[此前对话的摘要——当前任务以此为背景继续]\n{summary}\n[摘要结束]',
    }
    messages[1:tail_start] = [summary_msg]
    return CompactResult(saved_tokens=max(0, before - estimate_tokens(messages)))


def _transcript_line(m: ChatMessage) -> str:
    """一条消息的转写行：有正文用正文，纯工具调用消息记调用个数。"""
    content = m.get('content')
    if content:
        return f"{m['role']}: {content}"
    calls = len(m.get('tool_calls') or [])
    return f'{m["role"]}: (tool_calls: {calls} 个)'
