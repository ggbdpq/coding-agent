"""网络守卫单测：SSRF 防线的判定表，逐条锁死。含 IPv6 展开形式与 ::ffff: 映射私网。"""
from __future__ import annotations

import unittest

from pcode.plugins.tools.netguard import check_url_literal, is_public_ipv4, is_public_ipv6


def blocked(raw: str) -> bool:
    return not check_url_literal(raw).ok


class ProtocolWhitelistTest(unittest.TestCase):
    def test_协议白名单仅http_https(self) -> None:
        self.assertTrue(blocked('ftp://example.com/x'))
        self.assertTrue(blocked('file:///etc/passwd'))
        self.assertFalse(blocked('https://example.com/x'))
        self.assertFalse(blocked('http://example.com/x'))


class ReservedHostTest(unittest.TestCase):
    def test_保留域名与字面内网IP一律拒绝(self) -> None:
        for raw in [
            'http://localhost/x',
            'http://api.localhost/x',
            'http://svc.internal/x',
            'http://machine.local/x',
            'http://127.0.0.1/x',
            'http://10.0.0.1/x',
            'http://192.168.1.1/x',
            'http://172.16.0.1/x',
            'http://169.254.169.254/meta',  # 云元数据端点
            'http://0.0.0.0/x',
            'http://100.64.0.1/x',  # CGNAT
            'http://[::1]/x',
            'http://[0:0:0:0:0:0:0:1]/x',  # ::1 的展开形式
            'http://[fd00::1]/x',
            'http://[fe80::1]/x',
            'http://[::ffff:192.168.0.1]/x',  # IPv4 映射形式里藏私网
        ]:
            self.assertTrue(blocked(raw), f'{raw} 应被拒绝')


class PublicHostTest(unittest.TestCase):
    def test_公网地址放行坏URL拒绝(self) -> None:
        self.assertFalse(blocked('https://api.deepseek.com/v1'))
        self.assertFalse(blocked('http://8.8.8.8/dns-query'))
        self.assertFalse(blocked('http://[2606:4700::1111]/x'))
        self.assertTrue(blocked('not a url'))
        # 非法字面 IP 在字面层按"普通域名"放行（与 tcode 的 isIP 行为一致），由 DNS 复检兜底
        self.assertFalse(blocked('http://256.1.1.1/x'))
        self.assertFalse(is_public_ipv4('256.1.1.1'))


class IPv4TableTest(unittest.TestCase):
    def test_isPublicIPv4判定表(self) -> None:
        self.assertTrue(is_public_ipv4('8.8.8.8'))
        self.assertTrue(is_public_ipv4('172.32.0.1'))  # 172 段只有 16-31 是私有
        self.assertFalse(is_public_ipv4('172.16.0.1'))
        self.assertFalse(is_public_ipv4('172.31.255.255'))
        self.assertFalse(is_public_ipv4('100.64.0.1'))  # CGNAT
        self.assertFalse(is_public_ipv4('198.18.0.1'))  # 基准测试
        self.assertFalse(is_public_ipv4('198.19.255.255'))
        self.assertFalse(is_public_ipv4('224.0.0.1'))  # 组播
        self.assertFalse(is_public_ipv4('255.255.255.255'))  # 广播
        self.assertFalse(is_public_ipv4('256.1.1.1'))  # 非法
        self.assertFalse(is_public_ipv4('1.2.3'))  # 非法


class IPv6TableTest(unittest.TestCase):
    def test_isPublicIPv6判定表含展开形式与映射回拆(self) -> None:
        self.assertTrue(is_public_ipv6('2606:4700::1111'))
        self.assertTrue(is_public_ipv6('::ffff:8.8.8.8'))  # 映射的公网 v4
        self.assertFalse(is_public_ipv6('::ffff:192.168.0.1'))  # 映射的私网 v4
        self.assertFalse(is_public_ipv6('0:0:0:0:0:0:0:1'))  # ::1 展开形式
        self.assertFalse(is_public_ipv6('::'))
        self.assertFalse(is_public_ipv6('::1'))
        self.assertFalse(is_public_ipv6('FE80:0:0:0:0:0:0:1'.lower()))  # 链路本地展开形式
        self.assertFalse(is_public_ipv6('fe80::1'))
        self.assertFalse(is_public_ipv6('fc00::1'))
        self.assertFalse(is_public_ipv6('fd12::1'))
        self.assertFalse(is_public_ipv6('fd00:0000:0000:0000:0000:0000:0000:0001'))  # ULA 展开
        self.assertFalse(is_public_ipv6('ff02::1'))  # 组播，保守拒绝
        self.assertFalse(is_public_ipv6('64:ff9b::192.0.2.33'))  # NAT64 已知前缀，保守拒绝
        self.assertFalse(is_public_ipv6('not-an-ip'))  # 非法


if __name__ == '__main__':
    unittest.main()
