"""共享词汇表：两种协议与核心逻辑共同依赖的线格式类型。

放 kernel 是因为 core/providers/session 都要引用，且不含任何行为。
内部消息统一用 OpenAI 形状（ChatMessage），Anthropic 协议在 provider 内做双向映射。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, ClassVar, Literal, NotRequired, Protocol, TypedDict

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
    # token 用量回调（R5）：provider 解析到 usage 即回调（prompt_tokens, completion_tokens）
    on_usage: Callable[[int, int], None] | None = None


class ChatClient(Protocol):
    """两种协议客户端的共同形状：agent loop 只认这个。"""

    def chat(
        self, messages: list[ChatMessage], opts: ChatOptions | None = None
    ) -> CompletionResult: ...


@dataclass
class YoloRef:
    """会话级 yolo 开关（--yolo 或 /yolo / 权限确认里的 a 都改它）。"""

    value: bool = False


# —— 规范事件流（R1 事件模型，对齐 tcode 的 AgentEvent）： ——
# turn 是唯一生产者，壳渲染、审计与测试断言都只消费事件，不拼装。
# 每个变体一个 dataclass；类变量 type 是固定判别标识（ClassVar 不进 __init__/__eq__）。

# turn 终态原因：completed=模型收尾；aborted=用户中止；error=异常。
# 同步模型里 aborted 由 KeyboardInterrupt（Ctrl+C）触发，error 由异常触发，与 tcode 对齐。
TurnEndReason = Literal['completed', 'aborted', 'error']


@dataclass
class TurnStart:
    """一轮对话开始；id 是本轮的 uuid。"""

    id: str
    type: ClassVar[str] = 'turn_start'


@dataclass
class User:
    """用户输入原文（入列前发出）。"""

    text: str
    type: ClassVar[str] = 'user'


@dataclass
class TextDelta:
    """模型正文增量（工具调用参数不走这里）。"""

    delta: str
    type: ClassVar[str] = 'text_delta'


@dataclass
class ToolCallEvent:
    """模型请求调用工具（执行前发出）。

    命名带 Event 后缀：线格式的 ToolCall TypedDict 已占用同名（两者字段不同形）。
    """

    call_id: str
    name: str
    args: dict[str, object]
    type: ClassVar[str] = 'tool_call'


@dataclass
class ToolResult:
    """工具执行完成；summary 是结果首行（拒绝/失败也是一条结果）。"""

    call_id: str
    name: str
    summary: str
    ms: int
    type: ClassVar[str] = 'tool_result'


@dataclass
class Permission:
    """权限确认请求（契约占位：壳可直接渲染，闸门回调仍走 check）。"""

    id: str
    tool: str
    preview: str
    type: ClassVar[str] = 'permission'


@dataclass
class Trimmed:
    """上下文超预算且压缩失败，N 条早期工具输出被替换为占位文本（降级兜底）。"""

    count: int
    type: ClassVar[str] = 'trimmed'


@dataclass
class Compact:
    """上下文已压缩（v0.4-1）：旧对话替换为摘要 + 最近原文，saved_tokens 为估算节省。"""

    saved_tokens: int
    type: ClassVar[str] = 'compact'


@dataclass
class Usage:
    """一次模型调用的 token 用量（R5）：provider 解析 SSE 的 usage 字段后经 turn 发出。"""

    prompt_tokens: int
    completion_tokens: int
    type: ClassVar[str] = 'usage'


@dataclass
class TurnEnd:
    """一轮结束；异常路径发 aborted/error 后仍上抛（每轮恰一个终态事件）。"""

    reason: TurnEndReason
    error: str | None = None
    type: ClassVar[str] = 'turn_end'


# 判别联合：消费端用 isinstance / match 分支渲染
AgentEvent = (
    TurnStart
    | User
    | TextDelta
    | ToolCallEvent
    | ToolResult
    | Permission
    | Trimmed
    | Compact
    | Usage
    | TurnEnd
)
