// 网络守卫单测：SSRF 防线的判定表，逐条锁死（对齐 tcode/test/netguard.test.ts，
// 另按 Go 标准库语义补 IPv6 展开形式与 ::ffff: 映射私网的用例）。
package tools

import "testing"

func blocked(t *testing.T, raw string) bool {
	t.Helper()
	return !CheckURLLiteral(raw).OK
}

func TestNetguardProtocolWhitelist(t *testing.T) {
	cases := []struct {
		raw    string
		blocks bool
	}{
		{"ftp://example.com/x", true},
		{"file:///etc/passwd", true},
		{"https://example.com/x", false},
		{"http://example.com/x", false},
	}
	for _, c := range cases {
		if got := blocked(t, c.raw); got != c.blocks {
			t.Fatalf("%s 应 blocked=%v，got %v", c.raw, c.blocks, got)
		}
	}
}

func TestNetguardReservedHostsAndLiteralIPs(t *testing.T) {
	for _, raw := range []string{
		"http://localhost/x",
		"http://api.localhost/x",
		"http://svc.internal/x",
		"http://svc.local/x",
		"http://127.0.0.1/x",
		"http://10.0.0.1/x",
		"http://192.168.1.1/x",
		"http://172.16.0.1/x",
		"http://169.254.169.254/meta", // 云元数据端点
		"http://100.64.0.1/x",         // CGNAT
		"http://198.18.0.1/x",         // 基准测试
		"http://0.0.0.0/x",
		"http://224.0.0.1/x",
		"http://[::1]/x",
		"http://[fd00::1]/x",
		"http://[fe80::1]/x",
		// IPv6 展开形式
		"http://[0:0:0:0:0:0:0:1]/x",       // 展开的环回
		"http://[0:0:0:0:0:ffff:c0a8:1]/x", // 展开的 ::ffff:192.168.0.1（映射私网）
	} {
		if !blocked(t, raw) {
			t.Fatalf("%s 应被拒绝", raw)
		}
	}
}

func TestNetguardPublicAllowedAndBadURL(t *testing.T) {
	for _, raw := range []string{
		"https://api.deepseek.com/v1",
		"http://8.8.8.8/dns-query",
		"http://[2606:4700::1111]/x",
		"http://[0:0:0:0:0:ffff:808:808]/x", // 展开的 ::ffff:8.8.8.8（映射公网）
	} {
		if blocked(t, raw) {
			t.Fatalf("%s 应放行（字面层）", raw)
		}
	}
	if !blocked(t, "not a url") {
		t.Fatalf("坏 URL 应被拒绝")
	}
	// Go 的 net/url 把 http:///no-host 解析成空主机名：字面层即拒绝（比 WHATWG 更严，方向安全）
	if !blocked(t, "http:///no-host") {
		t.Fatalf("空主机名应被拒绝")
	}
}

func TestIsPublicIPv4Table(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"8.8.8.8", true},
		{"172.32.0.1", true},  // 172 段只有 16-31 是私有
		{"172.16.0.1", false}, // 私有
		{"100.64.0.1", false}, // CGNAT
		{"100.128.0.1", true},
		{"198.18.0.1", false}, // 基准测试
		{"198.19.255.1", false},
		{"198.20.0.1", true},
		{"224.0.0.1", false}, // 组播
		{"256.1.1.1", false}, // 非法
		{"1.2.3.4.5", false}, // 非法
	}
	for _, c := range cases {
		if got := IsPublicIPv4(c.ip); got != c.want {
			t.Fatalf("IsPublicIPv4(%q)=%v，want %v", c.ip, got, c.want)
		}
	}
}

func TestIsPublicIPv6Table(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"2606:4700::1111", true},
		{"::ffff:8.8.8.8", true},         // 映射的公网 v4
		{"::ffff:192.168.0.1", false},    // 映射的私网 v4
		{"::ffff:c0a8:1", false},         // 同上，十六进制展开形式
		{"0:0:0:0:0:ffff:808:808", true}, // 展开的 ::ffff:8.8.8.8
		{"::", false},                    // 未指定
		{"::1", false},                   // 环回
		{"0:0:0:0:0:0:0:1", false},       // 展开的环回
		{"fe80::1", false},               // 链路本地
		{"feb0::1", false},               // 链路本地（fe80::/10 上半段）
		{"fc00::1", false},               // ULA
		{"fd12::1", false},               // ULA
		{"64:ff9b::1.2.3.4", false},      // NAT64 已知前缀，保守拒绝
		{"garbage", false},               // 非法保守拒绝
	}
	for _, c := range cases {
		if got := IsPublicIPv6(c.ip); got != c.want {
			t.Fatalf("IsPublicIPv6(%q)=%v，want %v", c.ip, got, c.want)
		}
	}
}
