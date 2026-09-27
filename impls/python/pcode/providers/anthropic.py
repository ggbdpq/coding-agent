"""Anthropic Messages 协议客户端（POST {baseUrl}/v1/messages）+ provider 插件：

服务于 Claude 官方 API、DeepSeek /anthropic 端点及同类兼容中转。
消息映射：system 提为顶层参数；tool 消息转为 user 角色的 tool_result 块；
相邻同角色消息合并（Anthropic 要求 user/assistant 严格交替）。
"""
from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.request
from typing import Any

from pcode.kernel.plugin import ProviderPlugin, define_plugin
from pcode.kernel.types import (
    ChatMessage,
    ChatOptions,
    CompletionResult,
    ToolCall,
    ToolSchema,
)
from pcode.providers.retry import RetryableError, with_retry
from pcode.providers.sse import sse_data

ANTHROPIC_VERSION = '2023-06-01'
DEFAULT_MAX_TOKENS = 8192

_TIMEOUT_SEC = 300


def to_anthropic_request(
    messages: list[ChatMessage],
    model: str,
    max_tokens: int,
    tools: list[ToolSchema] | None = None,
) -> dict[str, Any]:
    """内部（OpenAI 形状）消息 → Anthropic 请求体。"""
    system: list[str] = []
    flat: list[dict[str, Any]] = []
    for m in messages:
        role = m['role']
        if role == 'system':
            if m.get('content'):
                system.append(m['content'])
            continue
        if role == 'user':
            flat.append({'role': 'user', 'content': [{'type': 'text', 'text': m.get('content') or ''}]})
            continue
        if role == 'tool':
            flat.append(
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'tool_result',
                            'tool_use_id': m.get('tool_call_id') or '',
                            'content': m.get('content') or '',
                        }
                    ],
                }
            )
            continue
        blocks: list[dict[str, Any]] = []
        if m.get('content'):
            blocks.append({'type': 'text', 'text': m['content']})
        for tc in m.get('tool_calls') or []:
            try:
                tool_input = json.loads(tc['function']['arguments'] or '{}')
            except json.JSONDecodeError:
                tool_input = {}  # 非法参数保持 {}，让对端/工具层报错
            blocks.append(
                {'type': 'tool_use', 'id': tc['id'], 'name': tc['function']['name'], 'input': tool_input}
            )
        flat.append({'role': 'assistant', 'content': blocks})

    merged: list[dict[str, Any]] = []
    for m in flat:
        if merged and merged[-1]['role'] == m['role']:
            merged[-1]['content'].extend(m['content'])
        else:
            merged.append(m)

    request: dict[str, Any] = {'model': model, 'max_tokens': max_tokens, 'messages': merged, 'stream': True}
    if system:
        request['system'] = '\n'.join(system)
    if tools:
        request['tools'] = [
            {
                'name': t['function']['name'],
                'description': t['function']['description'],
                'input_schema': t['function']['parameters'],
            }
            for t in tools
        ]
    return request


class AnthropicProvider:
    def __init__(self, base_url: str, api_key: str, model: str) -> None:
        self._base_url = base_url
        self._api_key = api_key
        self._model = model

    def chat(
        self, messages: list[ChatMessage], opts: ChatOptions | None = None
    ) -> CompletionResult:
        """与 OpenAI 版相同的重试纪律：最多 3 次，仅首字节前可重试。"""
        effective = opts or ChatOptions()
        return with_retry(lambda: self._attempt(messages, effective))

    def _post(self, messages: list[ChatMessage], opts: ChatOptions) -> http.client.HTTPResponse:
        body = to_anthropic_request(messages, self._model, DEFAULT_MAX_TOKENS, opts.tools)
        request = urllib.request.Request(
            f'{self._base_url}/v1/messages',
            data=json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
            headers={
                'content-type': 'application/json',
                'x-api-key': self._api_key,
                'authorization': f'Bearer {self._api_key}',
                'anthropic-version': ANTHROPIC_VERSION,
            },
            method='POST',
        )
        try:
            return urllib.request.urlopen(request, timeout=_TIMEOUT_SEC)
        except urllib.error.HTTPError as e:
            try:
                raw = e.read().decode('utf-8', errors='replace')
            except OSError:
                raw = ''
            brief = f'{raw[:300]}…' if len(raw) > 300 else raw
            message = f'HTTP {e.code}：{brief or e.reason}'
            if e.code == 429 or e.code == 529 or e.code >= 500:
                raise RetryableError(message) from e
            raise RuntimeError(message) from e

    def _attempt(self, messages: list[ChatMessage], opts: ChatOptions) -> CompletionResult:
        resp = self._post(messages, opts)

        # 事件装配：text_delta 累加正文；tool_use 块按 index 收 input_json_delta 碎片
        text = ''
        tool_blocks: dict[int, dict[str, str]] = {}
        try:
            for data in sse_data(resp):
                try:
                    ev: dict[str, Any] = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if ev.get('type') == 'error':
                    raise RuntimeError(f"流内错误：{(ev.get('error') or {}).get('message') or data}")
                if ev.get('type') == 'content_block_start':
                    block = ev.get('content_block') or {}
                    if block.get('type') == 'tool_use':
                        tool_blocks[int(ev.get('index', 0))] = {
                            'id': block.get('id', ''),
                            'name': block.get('name', ''),
                            'json': '',
                        }
                    continue
                if ev.get('type') == 'content_block_delta':
                    delta = ev.get('delta') or {}
                    if delta.get('type') == 'text_delta' and delta.get('text'):
                        text += delta['text']
                        if opts.on_text:
                            opts.on_text(delta['text'])
                    elif delta.get('type') == 'input_json_delta' and delta.get('partial_json'):
                        slot = tool_blocks.get(int(ev.get('index', 0)))
                        if slot is not None:
                            slot['json'] += delta['partial_json']
                # message_start/message_delta 携带 token 用量（R5：usage 进事件）
                usage = (
                    (ev.get('message') or {}).get('usage')
                    if ev.get('type') == 'message_start'
                    else ev.get('usage')
                )
                if usage and (usage.get('input_tokens') or usage.get('output_tokens')):
                    if opts.on_usage:
                        opts.on_usage(
                            int(usage.get('input_tokens') or 0),
                            int(usage.get('output_tokens') or 0),
                        )
                # message_delta / message_stop / ping：块拼完即返回，无需特殊处理
        except (OSError, http.client.HTTPException) as e:
            # 正文已开始接收：中断不重试，避免内容重复
            raise RuntimeError(f'流中断：{e}') from e

        tool_calls: list[ToolCall] = []
        for index, slot in sorted(tool_blocks.items()):
            # 解析一遍再序列化：既验证 JSON 完整性，也归一成内部 arguments 字符串
            try:
                args = json.dumps(json.loads(slot['json'] or '{}'), ensure_ascii=False)
            except json.JSONDecodeError:
                args = slot['json'] or '{}'  # 流被截断时保留原文，工具层的 json.loads 会兜底报错
            tool_calls.append(
                {
                    'id': slot['id'] or f'toolu_{index}',
                    'type': 'function',
                    'function': {'name': slot['name'], 'arguments': args},
                }
            )

        message: ChatMessage = {'role': 'assistant', 'content': text or None}
        if tool_calls:
            message['tool_calls'] = tool_calls
        return {'message': message}


plugin = define_plugin(
    ProviderPlugin(
        name='anthropic',
        kind='provider',
        matches=lambda base_url: '/anthropic' in base_url,
        create=lambda config: AnthropicProvider(config.base_url, config.api_key, config.model),
    )
)
