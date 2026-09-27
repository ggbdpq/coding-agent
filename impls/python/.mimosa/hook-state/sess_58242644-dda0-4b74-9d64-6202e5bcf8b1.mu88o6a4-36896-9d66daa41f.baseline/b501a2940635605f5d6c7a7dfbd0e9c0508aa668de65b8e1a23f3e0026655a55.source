"""web_fetch 工具：抓取公网页面文本，供模型查文档/API 说明。

安全三道闸（实现即验收条件）：仅 http/https；字面与 DNS 双重拒绝私有/保留地址；
重定向不自动跟随——每跳重新过守卫，杜绝"公网 302 跳内网"。
同步阻塞模型：urllib + 禁用自动重定向的 opener，3xx 以 HTTPError 形式交回逐跳复检。
"""
from __future__ import annotations

import re
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urljoin, urlsplit

from pcode.kernel.plugin import ToolPlugin, define_plugin
from pcode.plugins.tools.netguard import assert_resolves_public, check_url_literal

MAX_BYTES = 512 * 1024
DEFAULT_MAX_CHARS = 8000
MAX_REDIRECTS = 5
TIMEOUT_SEC = 20


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """禁用自动重定向：3xx 以 HTTPError 形式交回调用方，逐跳复检。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def html_to_text(html: str) -> str:
    """极简 HTML→文本：去 script/style 与标签。不做实体全解码，够模型读即可。"""
    text = re.sub(r'<script[\s\S]*?</script>', ' ', html, flags=re.IGNORECASE)
    text = re.sub(r'<style[\s\S]*?</style>', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def _preview(args: dict[str, Any]) -> str:
    return f'GET {args.get("url")}（出站网络请求）'


def _run(args: dict[str, Any]) -> str:
    raw = str(args.get('url') or '')
    check = check_url_literal(raw)
    if not check.ok:
        return check.reason or '错误：URL 不合规'
    current = check.url or raw

    # 手动跟随重定向：每一跳都重新过字面 + DNS 守卫
    status = 0
    reason = ''
    content_type = ''
    body = b''
    final_url = current
    reached = False
    for _hop in range(MAX_REDIRECTS + 1):
        hop_check = check_url_literal(current)
        if not hop_check.ok:
            return hop_check.reason or '错误：重定向目标不合规'
        try:
            assert_resolves_public(urlsplit(current).hostname or '')
        except Exception as e:
            return str(e)
        request = urllib.request.Request(
            current, headers={'user-agent': 'pcode-web-fetch/0.1'}, method='GET'
        )
        try:
            resp = _opener.open(request, timeout=TIMEOUT_SEC)
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:
                status, reason = e.code, str(e.reason)
                loc = e.headers.get('Location')
                if not loc:
                    break
                current = urljoin(current, loc)
                continue
            return f'错误：HTTP {e.code} {e.reason}'
        except (urllib.error.URLError, OSError) as e:
            return f'错误：请求失败：{e}'
        status = resp.status
        content_type = resp.headers.get('Content-Type', '')
        # 读到上限即停：不把超大响应整个拖回内存
        body = resp.read(MAX_BYTES)
        resp.close()
        reached = True
        final_url = current
        break

    if not reached:
        if 300 <= status < 400:
            return f'错误：HTTP {status} {reason}'
        return '错误：请求未发出'

    text = body.decode('utf-8', errors='replace')
    if 'html' in content_type:
        text = html_to_text(text)
    try:
        max_chars = int(args.get('max_chars', DEFAULT_MAX_CHARS))
    except (TypeError, ValueError):
        max_chars = DEFAULT_MAX_CHARS
    max_chars = max(200, max_chars)
    note = ''
    if len(text) > max_chars:
        note = f'\n…（已截断，原文 {len(text)} 字符，可用 max_chars 调大）'
    return f'HTTP {status} · {content_type or "未知类型"} · {final_url}\n\n{text[:max_chars]}{note}'


plugin = define_plugin(
    ToolPlugin(
        name='web_fetch',
        kind='tool',
        description=(
            '抓取一个公网 URL 的页面文本（仅 http/https）。'
            '用于查阅文档、API 说明、报错线索；内网/私有地址会被拒绝。'
        ),
        parameters={
            'type': 'object',
            'properties': {
                'url': {'type': 'string', 'description': '完整的 http(s) URL'},
                'max_chars': {
                    'type': 'number',
                    'description': f'返回正文最大字符数，默认 {DEFAULT_MAX_CHARS}',
                },
            },
            'required': ['url'],
        },
        needs_permission=True,
        preview=_preview,
        run=_run,
    )
)
