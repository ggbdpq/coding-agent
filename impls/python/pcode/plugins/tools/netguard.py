"""网络守卫：web_fetch 的 SSRF 防线。

规则：仅 http/https；拒绝会解析到环回/私有/保留地址的主机；重定向逐跳复检。
纯函数部分（协议/字面 IP）独立导出方便单测，DNS 部分单独一个入口。
与 tcode 的差异：Python 侧用标准库 ipaddress 解析主机名，天然覆盖
"0:0:0:0:0:0:0:1" 这类 IPv6 展开形式（tcode 的正则方案只认缩写形式）。
"""
from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

_ULA_V6 = ipaddress.ip_network('fc00::/7')
_NAT64_V6 = ipaddress.ip_network('64:ff9b::/96')


@dataclass
class UrlCheck:
    ok: bool
    reason: str | None = None
    url: str | None = None


def _ip_version(text: str) -> int:
    """是合法字面 IP 时返回 4/6，否则 0。"""
    try:
        return ipaddress.ip_address(text).version
    except ValueError:
        return 0


def check_url_literal(raw: str) -> UrlCheck:
    """协议与主机名字面校验（不含 DNS）。"""
    parts = urlsplit(raw)
    if parts.scheme not in ('http', 'https'):
        if not parts.scheme and not parts.netloc:
            return UrlCheck(ok=False, reason='错误：URL 无法解析')
        return UrlCheck(ok=False, reason=f'错误：只允许 http/https 协议，收到 {parts.scheme}:')
    # urlsplit().hostname 已小写化并剥掉 IPv6 字面量的方括号
    host = parts.hostname or ''
    if not host:
        return UrlCheck(ok=False, reason='错误：URL 缺少主机名')
    if _is_literal_blocked(host):
        return UrlCheck(ok=False, reason=f'错误：拒绝访问私有/保留地址：{host}（已拦截，SSRF 防护）')
    return UrlCheck(ok=True, url=raw)


def _is_literal_blocked(host: str) -> bool:
    """主机名是字面 IP 或保留域名时的直接判定；普通域名返回 False（交给 DNS 复检）。"""
    h = host.lower()
    if h == 'localhost' or h.endswith('.localhost') or h.endswith('.internal') or h.endswith('.local'):
        return True
    version = _ip_version(h)
    if version == 4:
        return not is_public_ipv4(h)
    if version == 6:
        return not is_public_ipv6(h)
    return False


def is_public_ipv4(ip: str) -> bool:
    """IPv4 是否公网。覆盖常见保留段；清单取向是"保守拒绝"。"""
    parts = ip.split('.')
    if len(parts) != 4:
        return False
    nums: list[int] = []
    for p in parts:
        if not p.isdigit():
            return False
        n = int(p)
        if n < 0 or n > 255:
            return False
        nums.append(n)
    a, b = nums[0], nums[1]
    if a in (0, 10, 127):
        return False  # 本网络 / 私有 / 环回
    if a == 169 and b == 254:
        return False  # 链路本地
    if a == 172 and 16 <= b <= 31:
        return False  # 私有
    if a == 192 and b == 168:
        return False  # 私有
    if a == 100 and 64 <= b <= 127:
        return False  # CGNAT
    if a == 198 and b in (18, 19):
        return False  # 基准测试
    if a >= 224:
        return False  # 组播 + 保留 + 广播
    return True


def is_public_ipv6(ip: str) -> bool:
    """IPv6 是否公网。环回/ULA/链路本地/IPv4 映射回 v4 判定，其余保守放行。

    ipaddress 负责解析与规范化：展开形式（0:0:0:0:0:0:0:1）、大写、内嵌 v4
    （::ffff:8.8.8.8）都收敛成同一个地址对象再判定。
    """
    try:
        addr = ipaddress.IPv6Address(ip)
    except ValueError:
        return False  # 非法一律按"不公开"处理
    if addr.is_unspecified or addr.is_loopback:
        return False  # :: 与 ::1
    if addr.is_link_local:
        return False  # fe80::/10
    if addr in _ULA_V6:
        return False  # fc00::/7
    mapped = addr.ipv4_mapped
    if mapped is not None:
        return is_public_ipv4(str(mapped))  # ::ffff:a.b.c.d 回拆 v4 判定
    if addr in _NAT64_V6:
        return False  # NAT64 已知前缀，保守拒绝
    if addr.is_multicast or addr.is_reserved:
        return False  # ff00::/8 等保留段，保守拒绝
    return True


def assert_resolves_public(hostname: str) -> None:
    """DNS 复检：任一解析结果不公开即抛错（防域名指内网的绕行）。"""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        raise RuntimeError(f'错误：{hostname} 无法解析（DNS 查询失败：{e}）') from e
    if not infos:
        raise RuntimeError(f'错误：{hostname} 没有解析到任何地址')
    seen: set[str] = set()
    for info in infos:
        address: str = info[4][0]
        if address in seen:
            continue
        seen.add(address)
        ip_part = address.split('%', 1)[0]  # Windows v6 带作用域 id（fe80::1%12）
        if info[0] == socket.AF_INET:
            public = is_public_ipv4(ip_part)
        elif info[0] == socket.AF_INET6:
            public = is_public_ipv6(ip_part)
        else:
            public = False
        if not public:
            raise RuntimeError(
                f'错误：{hostname} 解析到私有/保留地址 {ip_part}（已拦截，SSRF 防护）'
            )
