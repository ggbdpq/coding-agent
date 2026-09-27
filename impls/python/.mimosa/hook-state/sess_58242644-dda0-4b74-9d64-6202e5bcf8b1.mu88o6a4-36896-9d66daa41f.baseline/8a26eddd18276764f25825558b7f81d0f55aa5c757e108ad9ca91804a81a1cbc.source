"""App：插件的运行环境——命令与壳通过它拿能力，彼此互不 import。

kernel 不 import core：store 与 fresh_messages 由装配方（__main__）注入，
这里只声明最小的结构化接口（SessionStoreLike 协议 + SessionSummary 数据类）。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from pcode.kernel.config import Config
from pcode.kernel.registry import Registry
from pcode.kernel.types import ChatClient, ChatMessage, YoloRef

VERSION = '0.5.0'


@dataclass
class SessionSummary:
    file: str
    # 修改时间（epoch 秒，浮点）
    mtime: float
    # 首条用户输入，用作列表标签
    label: str


class SessionStoreLike(Protocol):
    """core/session.SessionStore 满足此结构（kernel 不直接依赖 core）。"""

    def start(self, meta: dict[str, Any] | None = None) -> None: ...

    def append(self, message: ChatMessage) -> None: ...

    def list_recent(self, n: int) -> list[SessionSummary]: ...

    def load(self, file: str) -> list[ChatMessage]: ...


class App:
    config: Config
    registry: Registry
    provider: ChatClient
    store: SessionStoreLike
    yolo: YoloRef
    # Plan Mode（只读规划）：开启时写类工具被 agent_loop 拒绝
    plan_mode: YoloRef
    # 当前会话消息；命令/壳直接读写这个数组
    messages: list[ChatMessage]

    def __init__(
        self,
        config: Config,
        registry: Registry,
        provider: ChatClient,
        store: SessionStoreLike,
        yolo: YoloRef,
        fresh_messages: Callable[[], list[ChatMessage]],
    ) -> None:
        self.config = config
        self.registry = registry
        self.provider = provider
        self.store = store
        self.yolo = yolo
        # Plan Mode 只在本会话内切换（/plan），不从启动参数来
        self.plan_mode = YoloRef(value=False)
        self._fresh_messages = fresh_messages
        self.messages = []
        self.reset_messages()
        self.start_session()

    def start_session(self, extra: dict[str, Any] | None = None) -> None:
        """开新会话文件（/new、/resume 都换文件，永不追加旧文件）。"""
        meta: dict[str, Any] = {
            'version': VERSION,
            'model': self.config.model,
            'cwd': os.getcwd(),
            'yolo': self.yolo.value,
        }
        meta.update(extra or {})
        self.store.start(meta)

    def reset_messages(self) -> None:
        """messages 换成全新 system 数组。"""
        self.messages = self._fresh_messages()


def create_app(
    config: Config,
    registry: Registry,
    *,
    yolo: bool,
    fresh_messages: Callable[[], list[ChatMessage]],
    store: SessionStoreLike,
) -> App:
    provider = select_provider(config, registry)
    return App(
        config=config,
        registry=registry,
        provider=provider,
        store=store,
        yolo=YoloRef(value=yolo),
        fresh_messages=fresh_messages,
    )


def select_provider(config: Config, registry: Registry) -> ChatClient:
    """显式配置的 protocol 按名选；否则按注册顺序取首个 matches 命中的 provider。"""
    if config.protocol:
        explicit = next((p for p in registry.providers() if p.name == config.protocol), None)
        if explicit is None:
            names = ', '.join(p.name for p in registry.providers())
            raise RuntimeError(f'没有名为 {config.protocol} 的 provider 插件（可用：{names}）')
        return explicit.create(config)
    hit = next((p for p in registry.providers() if p.matches(config.base_url)), None)
    if hit is None:
        raise RuntimeError(f'没有 provider 插件能处理 BASE_URL：{config.base_url}')
    return hit.create(config)
