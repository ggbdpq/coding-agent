"""注册表：插件按 kind 存取；装配顺序即优先级（provider 的 matches 首个命中生效）。"""
from __future__ import annotations

from typing import TYPE_CHECKING, cast

from pcode.kernel.types import ToolSchema

if TYPE_CHECKING:
    from pcode.kernel.plugin import CommandPlugin, Plugin, ProviderPlugin, ShellPlugin, ToolDef


class Registry:
    def __init__(self) -> None:
        self._plugins: list[Plugin] = []

    def register(self, plugin: Plugin) -> Registry:
        if any(p.kind == plugin.kind and p.name == plugin.name for p in self._plugins):
            raise RuntimeError(f'插件重名：{plugin.kind}/{plugin.name}')
        self._plugins.append(plugin)
        return self

    def register_all(self, plugins: list[Plugin]) -> Registry:
        for p in plugins:
            self.register(p)
        return self

    def tools(self) -> list[ToolDef]:
        return cast('list[ToolDef]', [p for p in self._plugins if p.kind == 'tool'])

    def providers(self) -> list[ProviderPlugin]:
        return cast('list[ProviderPlugin]', [p for p in self._plugins if p.kind == 'provider'])

    def commands(self) -> list[CommandPlugin]:
        return cast('list[CommandPlugin]', [p for p in self._plugins if p.kind == 'command'])

    def shell(self, name: str) -> ShellPlugin | None:
        return next(
            (p for p in self._plugins if p.kind == 'shell' and p.name == name),
            None,
        )

    def tool_schemas(self) -> list[ToolSchema]:
        """工具清单 → function calling 的 tools 参数。"""
        return to_schemas(self.tools())


def to_schemas(tools: list[ToolDef]) -> list[ToolSchema]:
    """独立导出：core/agent_loop 拿到的是裸工具数组，不经注册表实例。"""
    return [
        {
            'type': 'function',
            'function': {
                'name': t.name,
                'description': t.description,
                'parameters': t.parameters,
            },
        }
        for t in tools
    ]
