"""配置加载：环境变量 > ~/.pcode/config.json > 报错指路。

刻意不写死任何默认端点/模型——本地优先工具，用户自己决定请求发去哪。
协议选择不走这里：protocol 只有显式配置时才非空，自动识别由 provider 插件的 matches 做。
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, cast

from pcode.kernel.types import ProtocolName


@dataclass
class Config:
    api_key: str
    base_url: str
    model: str
    # 仅显式配置（PCODE_PROTOCOL / config.json）时非空；否则由 provider 插件按 URL 自动识别
    protocol: ProtocolName | None
    # 估算 token 上限，超过即触发上下文裁剪
    context_limit: int
    # ~/.pcode 目录，配置/会话/全局指令都住这里
    pcode_dir: str
    # 审批策略（R4）：normal=写类逐次确认（默认）；never=全部免确认（--yolo 等价）
    approval: Literal['normal', 'never'] | None = None
    # 写白名单（R4）：位于这些目录内的 write/edit 免确认（Path.resolve 归一化的绝对路径）。
    # bash/web_fetch 不受白名单影响（命令级操作无法按路径约束），仍逐次确认。
    allow_write_dirs: list[str] = field(default_factory=list)


def _read_json_config(pcode_dir: str) -> dict[str, Any]:
    file = os.path.join(pcode_dir, 'config.json')
    if not os.path.exists(file):
        return {}
    try:
        with open(file, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError(f'~/.pcode/config.json 解析失败：{e}') from e
    if not isinstance(data, dict):
        return {}
    return data


def _file_str(file_config: dict[str, Any], key: str) -> str:
    value = file_config.get(key)
    return value if isinstance(value, str) else ''


def load_config() -> Config:
    pcode_dir = os.path.join(os.path.expanduser('~'), '.pcode')
    file_config = _read_json_config(pcode_dir)
    api_key = os.environ.get('PCODE_API_KEY') or _file_str(file_config, 'apiKey')
    base_url = re.sub(r'/+$', '', os.environ.get('PCODE_BASE_URL') or _file_str(file_config, 'baseUrl'))
    model = os.environ.get('PCODE_MODEL') or _file_str(file_config, 'model')

    raw_limit = os.environ.get('PCODE_CONTEXT_LIMIT') or ''
    try:
        context_limit = int(raw_limit) if raw_limit else 0
    except ValueError:
        context_limit = 0
    if context_limit <= 0:
        context_limit = 100_000

    raw_protocol = (os.environ.get('PCODE_PROTOCOL') or _file_str(file_config, 'protocol')).lower()
    protocol: ProtocolName | None = None
    if raw_protocol:
        if raw_protocol not in ('openai', 'anthropic'):
            raise RuntimeError(f'PCODE_PROTOCOL 只能是 openai 或 anthropic，收到：{raw_protocol}')
        protocol = cast(ProtocolName, raw_protocol)

    # 审批策略（R4）：环境变量 > config.json approval 字段；只允许 normal/never，默认 None 即 normal
    raw_approval = (os.environ.get('PCODE_APPROVAL') or _file_str(file_config, 'approval')).lower()
    approval: Literal['normal', 'never'] | None = None
    if raw_approval:
        if raw_approval not in ('normal', 'never'):
            raise RuntimeError(f'PCODE_APPROVAL 只能是 normal 或 never，收到：{raw_approval}')
        approval = cast(Literal['normal', 'never'], raw_approval)

    # 写白名单（R4）：config.json allowWriteDirs 或环境变量 PCODE_ALLOW_WRITE（os.pathsep 分隔）
    raw_dirs = file_config.get('allowWriteDirs')
    if not isinstance(raw_dirs, list):
        raw_dirs = []
    raw_dirs = [d for d in raw_dirs if isinstance(d, str)]
    env_dirs = os.environ.get('PCODE_ALLOW_WRITE')
    if env_dirs and not raw_dirs:
        raw_dirs = env_dirs.split(os.pathsep)
    allow_write_dirs = [str(Path(d).resolve()) for d in raw_dirs if d and d.strip()]

    missing = [
        name
        for name, value in (
            ('PCODE_API_KEY', api_key),
            ('PCODE_BASE_URL', base_url),
            ('PCODE_MODEL', model),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            f'缺少模型配置：{"、".join(missing)}。\n'
            '设置方式（二选一）：\n'
            '  1. 环境变量：export PCODE_API_KEY=sk-xxx PCODE_BASE_URL=https://xxx/v1 PCODE_MODEL=模型名\n'
            '  2. 配置文件：~/.pcode/config.json 写 {"apiKey":"...","baseUrl":"...","model":"..."}\n'
            '任何 OpenAI 兼容端点都可以（本地中转、云 API 均可）。'
        )
    return Config(
        api_key=api_key,
        base_url=base_url,
        model=model,
        protocol=protocol,
        context_limit=context_limit,
        pcode_dir=pcode_dir,
        approval=approval,
        allow_write_dirs=allow_write_dirs,
    )
