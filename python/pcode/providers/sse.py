"""SSE 共用件：从 HTTP 响应体逐事件产出 data 字段内容，OpenAI 与 Anthropic 两种协议通用。"""
from __future__ import annotations

import http.client
from typing import Iterator


def sse_data(resp: http.client.HTTPResponse) -> Iterator[str]:
    """逐行读响应流，按空行切事件；每个事件的多行 data 拼成一个字符串产出。

    与 tcode 的实现同构：统一换行符后找事件边界，非 data 行（注释、心跳）忽略。
    """
    data_lines: list[str] = []
    for raw in resp:
        line = raw.decode('utf-8', errors='replace').rstrip('\r\n')
        if line == '':
            if data_lines:
                data = '\n'.join(data_lines)
                data_lines.clear()
                if data:
                    yield data
            continue
        if line.startswith('data:'):
            data_lines.append(line[5:].strip())
