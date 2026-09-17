"""插件内核：四类插件的类型与 define_plugin。

设计决策与 tcode 一致：统一接口 + kind 判别；内核只有类型与装配、没有任何行为——
"特权核心"最小化。插件文件统一 `plugin = define_plugin(...)` 命名导出。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Literal

from pcode.kernel.types import ChatClient

if TYPE_CHECKING:
    from pcode.kernel.app import App
    from pcode.kernel.config import Config


@dataclass
class ToolPlugin:
    """工具插件：一个文件一个工具，ToolDef 是它的别名（core/agent_loop 消费）。"""

    name: str
    description: str
    # JSON Schema，直传 function calling
    parameters: dict[str, Any]
    # 写类需要逐次确认，读类免确认
    needs_permission: bool
    # 权限确认时展示给用户看的内容
    preview: Callable[[dict[str, Any]], str]
    # 同步模型：run 是普通函数；错误一律 return '错误：...' 文本，不抛异常
    run: Callable[[dict[str, Any]], str]
    kind: Literal['tool'] = 'tool'


ToolDef = ToolPlugin


@dataclass
class ProviderPlugin:
    """协议插件：matches 按注册顺序首个命中的生效，兜底放清单最后。"""

    name: str
    matches: Callable[[str], bool]
    create: Callable[[Config], ChatClient]
    kind: Literal['provider'] = 'provider'


@dataclass
class CommandOutcome:
    exit: bool | None = None


@dataclass
class CommandPlugin:
    """斜杠命令插件：name 不含斜杠；输出自己 print，返回 exit 信号控制壳。

    动词用 run 而非 exec——命令只是函数调用，不碰 shell。
    """

    name: str
    usage: str
    summary: str
    run: Callable[['App', list[str]], CommandOutcome | None]
    kind: Literal['command'] = 'command'


@dataclass
class ShellPlugin:
    """交互壳插件：REPL/TUI/单发都是并列的壳，一次只起一个。"""

    name: str
    start: Callable[['App'], None]
    kind: Literal['shell'] = 'shell'


Plugin = ToolPlugin | ProviderPlugin | CommandPlugin | ShellPlugin


def define_plugin[P: Plugin](p: P) -> P:
    """恒等函数：只为类型推导与将来校验留口。"""
    return p
