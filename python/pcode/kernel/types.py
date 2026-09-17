"""共享词汇表：两种协议与核心逻辑共同依赖的线格式类型。

放 kernel 是因为 core/providers/session 都要引用，且不含任何行为。
内部消息统一用 OpenAI 形状（ChatMessage），Anthropic 协议在 provider 内做双向映射。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal, NotRequired, Protocol, TypedDict

# 显式配置的协议名（PCODE_PROTOCOL / config.json）；自动识别由 provider 插件的 matches 做
ProtocolName = Literal['openai', 'anthropic']

Role = Literal['system', 'user', 'assistant', 'tool']


class _ToolSchemaFunction(TypedDict):
    name: str
    description: str
    parameters: dict[str, object]


class ToolSchema(TypedDict):
    """function calling 的 tools 参数形状（直传两种协议，Anthropic 侧再做字段名映射）。"""

    type: str
    function: _ToolSchemaFunction


class _ToolCallFunction(TypedDict):
    name: str
    arguments: str


class ToolCall(TypedDict):
    id: str
    type: str
    function: _ToolCallFunction


class ChatMessage(TypedDict):
    """OpenAI 线格式的消息；内部 everywhere 用这一个形状。"""

    role: Role
    content: NotRequired[str | None]
    tool_calls: NotRequired[list[ToolCall]]
    tool_call_id: NotRequired[str]


class CompletionResult(TypedDict):
    message: ChatMessage


@dataclass
class ChatOptions:
    """一次模型调用的可选参数。

    同步阻塞模型没有 AbortSignal：用户中止即 KeyboardInterrupt，向上穿透。
    """

    tools: list[ToolSchema] | None = None
    # 正文增量回调（工具调用参数不走这里）
    on_text: Callable[[str], None] | None = None


class ChatClient(Protocol):
    """两种协议客户端的共同形状：agent loop 只认这个。"""

    def chat(
        self, messages: list[ChatMessage], opts: ChatOptions | None = None
    ) -> CompletionResult: ...


@dataclass
class YoloRef:
    """会话级 yolo 开关（--yolo 或 /yolo / 权限确认里的 a 都改它）。"""

    value: bool = False
