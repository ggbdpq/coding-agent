"""OpenAI 兼容 /chat/completions 客户端 + 对应 provider 插件（兜底：matches 恒真）。

只支持流式——coding agent 的体感底线，也顺便让工具调用前的等待可见。
同步阻塞模型：urllib.request 发请求，SSE 手写解析（providers/sse.py）。
"""
from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.request
from typing import Any

from pcode.kernel.plugin import ProviderPlugin, define_plugin
from pcode.kernel.types import ChatMessage, ChatOptions, CompletionResult, ToolCall
from pcode.providers.retry import RetryableError, with_retry
from pcode.providers.sse import sse_data

# socket 超时：约束连接与每次读块；流式生成中只要块间隔不超时即可长时间接收
_TIMEOUT_SEC = 300


class OpenAIProvider:
    def __init__(self, base_url: str, api_key: str, model: str) -> None:
        self._base_url = base_url
        self._api_key = api_key
        self._model = model

    def chat(
        self, messages: list[ChatMessage], opts: ChatOptions | None = None
    ) -> CompletionResult:
        """最多 3 次尝试；仅首字节前可重试（流已开始的中断不重试，避免内容重复）。"""
        effective = opts or ChatOptions()
        return with_retry(lambda: self._attempt(messages, effective))

    def _post(self, messages: list[ChatMessage], opts: ChatOptions) -> http.client.HTTPResponse:
        body: dict[str, Any] = {
            'model': self._model,
            'messages': messages,
            'stream': True,
            # R5：让服务端在流末尾附带 usage 统计（OpenAI 兼容端点的标准开关）
            'stream_options': {'include_usage': True},
        }
        if opts.tools:
            body['tools'] = opts.tools
        request = urllib.request.Request(
            f'{self._base_url}/chat/completions',
            data=json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
            headers={
                'content-type': 'application/json',
                'authorization': f'Bearer {self._api_key}',
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
            if e.code == 429 or e.code >= 500:
                raise RetryableError(message) from e
            raise RuntimeError(message) from e
        # URLError / OSError 原样上抛：with_retry 视为首字节前的网络失败，可重试

    def _attempt(self, messages: list[ChatMessage], opts: ChatOptions) -> CompletionResult:
        resp = self._post(messages, opts)

        # 流式增量装配：正文直接累加；工具调用按 index 分槽拼装碎片
        content = ''
        calls: dict[int, dict[str, str]] = {}
        try:
            for data in sse_data(resp):
                if data == '[DONE]':
                    break
                try:
                    chunk: dict[str, Any] = json.loads(data)
                except json.JSONDecodeError:
                    continue  # 非 JSON 行（注释、心跳）直接跳过
                # R5：usage 块随流末尾的空 choices chunk 到达，先于 choices 处理
                usage = chunk.get('usage')
                if usage and (usage.get('prompt_tokens') or usage.get('completion_tokens')):
                    if opts.on_usage:
                        opts.on_usage(
                            int(usage.get('prompt_tokens') or 0),
                            int(usage.get('completion_tokens') or 0),
                        )
                choices = chunk.get('choices') or []
                if not choices:
                    continue
                delta = choices[0].get('delta') or {}
                text = delta.get('content')
                if text:
                    content += text
                    if opts.on_text:
                        opts.on_text(text)
                for tc in delta.get('tool_calls') or []:
                    index = int(tc.get('index', 0))
                    slot = calls.setdefault(index, {'id': '', 'name': '', 'args': ''})
                    if tc.get('id'):
                        slot['id'] = tc['id']
                    fn = tc.get('function') or {}
                    if fn.get('name'):
                        slot['name'] += fn['name']
                    if fn.get('arguments'):
                        slot['args'] += fn['arguments']
        except (OSError, http.client.HTTPException) as e:
            # 正文已开始接收：中断不重试，避免内容重复
            raise RuntimeError(f'流中断：{e}') from e

        tool_calls: list[ToolCall] = [
            {
                'id': slot['id'] or f'call_{index}',
                'type': 'function',
                'function': {'name': slot['name'], 'arguments': slot['args'] or '{}'},
            }
            for index, slot in sorted(calls.items())
        ]
        message: ChatMessage = {'role': 'assistant', 'content': content or None}
        if tool_calls:
            message['tool_calls'] = tool_calls
        return {'message': message}


plugin = define_plugin(
    ProviderPlugin(
        name='openai',
        kind='provider',
        # 兜底：注册顺序放清单最后，没被其他 provider 命中的 BASE_URL 都走 OpenAI 兼容
        matches=lambda _base_url: True,
        create=lambda config: OpenAIProvider(config.base_url, config.api_key, config.model),
    )
)
