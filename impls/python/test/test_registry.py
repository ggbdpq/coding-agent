"""内核注册表单测：锁死按类取用、重名拒绝、schema 形状。"""
from __future__ import annotations

import unittest
from typing import cast

from pcode.kernel.plugin import (
    CommandPlugin,
    Plugin,
    ProviderPlugin,
    ShellPlugin,
    ToolPlugin,
    define_plugin,
)
from pcode.kernel.registry import Registry
from pcode.kernel.types import ChatClient, ChatMessage, ChatOptions, CompletionResult


def fake_tool() -> ToolPlugin:
    return define_plugin(
        ToolPlugin(
            name='t1',
            kind='tool',
            description='测试工具',
            parameters={'type': 'object', 'properties': {}},
            needs_permission=False,
            preview=lambda _args: '',
            run=lambda _args: 'ok',
        )
    )


def fake_provider() -> ProviderPlugin:
    class _Client:
        def chat(
            self, messages: list[ChatMessage], opts: ChatOptions | None = None
        ) -> CompletionResult:
            return {'message': {'role': 'assistant', 'content': ''}}

    return define_plugin(
        ProviderPlugin(
            name='fake',
            kind='provider',
            matches=lambda _base_url: True,
            create=lambda _config: cast(ChatClient, _Client()),
        )
    )


def fake_command(name: str = 'cmd1') -> CommandPlugin:
    return define_plugin(
        CommandPlugin(
            name=name,
            kind='command',
            usage=f'/{name}',
            summary='测试命令',
            run=lambda _app, _args: None,
        )
    )


def fake_shell() -> ShellPlugin:
    return define_plugin(ShellPlugin(name='repl', kind='shell', start=lambda _app: None))


class RegistryTest(unittest.TestCase):
    def test_注册后按类取用(self) -> None:
        plugins: list[Plugin] = [fake_tool(), fake_provider(), fake_command(), fake_shell()]
        r = Registry().register_all(plugins)
        self.assertEqual(len(r.tools()), 1)
        self.assertEqual(len(r.providers()), 1)
        self.assertEqual(len(r.commands()), 1)
        shell = r.shell('repl')
        self.assertIsNotNone(shell)
        assert shell is not None
        self.assertEqual(shell.name, 'repl')
        self.assertIsNone(r.shell('不存在'))

    def test_同kind重名拒绝跨kind同名允许(self) -> None:
        r = Registry().register(fake_tool())
        with self.assertRaisesRegex(RuntimeError, '插件重名'):
            r.register(fake_tool())
        # 不同 kind，允许同名
        r.register(fake_command(name='t1'))
        self.assertEqual([c.name for c in r.commands()], ['t1'])

    def test_toolSchemas输出function_calling形状(self) -> None:
        r = Registry().register(fake_tool())
        self.assertEqual(
            r.tool_schemas(),
            [
                {
                    'type': 'function',
                    'function': {
                        'name': 't1',
                        'description': '测试工具',
                        'parameters': {'type': 'object', 'properties': {}},
                    },
                }
            ],
        )


if __name__ == '__main__':
    unittest.main()
