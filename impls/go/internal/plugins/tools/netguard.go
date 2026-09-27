// 网络守卫：web_fetch 的 SSRF 防线（实现即验收条件）。
// 规则：仅 http/https；拒绝会解析到环回/私有/保留地址的主机；重定向逐跳复检。
// 纯函数部分（协议/字面 IP）独立导出方便单测，DNS 部分单独一个入口。
// IPv6 一律先过 net.ParseIP：展开形式（如 0:0:0:0:0:ffff:c0a8:1）与
// ::ffff: 映射地址用 To4() 拆回 IPv4 复判，不靠字符串形状。
package tools

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// UrlCheck URL 字面校验结果。
type UrlCheck struct {
	OK     bool
	Reason string
	URL    *url.URL
}

// CheckURLLiteral 协议与主机名字面校验（不含 DNS）。
func CheckURLLiteral(raw string) UrlCheck {
	u, err := url.Parse(raw)
	if err != nil {
		return UrlCheck{OK: false, Reason: "错误：URL 无法解析"}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return UrlCheck{OK: false, Reason: fmt.Sprintf("错误：只允许 http/https 协议，收到 %s:", u.Scheme)}
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return UrlCheck{OK: false, Reason: "错误：URL 缺少主机名"}
	}
	if isLiteralBlocked(host) {
		return UrlCheck{OK: false, Reason: fmt.Sprintf("错误：拒绝访问私有/保留地址：%s（已拦截，SSRF 防护）", host)}
	}
	return UrlCheck{OK: true, URL: u}
}

// isLiteralBlocked 主机名是字面 IP 或保留域名时的直接判定；普通域名返回 false（交给 DNS 复检）。
func isLiteralBlocked(host string) bool {
	h := strings.ToLower(host)
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]") // URL 里 IPv6 字面量的残留方括号
	if h == "localhost" || strings.HasSuffix(h, ".localhost") ||
		strings.HasSuffix(h, ".internal") || strings.HasSuffix(h, ".local") {
		return true
	}
	ip := net.ParseIP(h)
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil && !strings.Contains(h, ":") {
		return !IsPublicIPv4(h) // 纯点分 IPv4
	}
	return !IsPublicIPv6(h)
}

// IsPublicIPv4 是否公网 IPv4。覆盖常见保留段；清单取向是"保守拒绝"。
func IsPublicIPv4(ip string) bool {
	p := strings.Split(ip, ".")
	if len(p) != 4 {
		return false
	}
	n := make([]int, 4)
	for i, s := range p {
		v := 0
		if s == "" || len(s) > 3 {
			return false
		}
		for _, c := range []byte(s) {
			if c < '0' || c > '9' {
				return false
			}
			v = v*10 + int(c-'0')
		}
		if v > 255 {
			return false
		}
		n[i] = v
	}
	a, b := n[0], n[1]
	if a == 0 || a == 10 || a == 127 {
		return false // 本网络 / 私有 / 环回
	}
	if a == 169 && b == 254 {
		return false // 链路本地
	}
	if a == 172 && b >= 16 && b <= 31 {
		return false // 私有
	}
	if a == 192 && b == 168 {
		return false // 私有
	}
	if a == 100 && b >= 64 && b <= 127 {
		return false // CGNAT
	}
	if a == 198 && (b == 18 || b == 19) {
		return false // 基准测试
	}
	if a >= 224 {
		return false // 组播 + 保留 + 广播
	}
	return true
}

// IsPublicIPv6 是否公网 IPv6。先过 net.ParseIP（天然支持展开形式）：
// IPv4 映射/兼容形式用 To4() 拆回 v4 判定；环回/未指定/链路本地/ULA 走标准库谓词；
// 其余保守放行。
func IsPublicIPv6(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false // 非法保守拒绝
	}
	if v4 := parsed.To4(); v4 != nil {
		// ::ffff:x.x.x.x（含十六进制展开形式）与 IPv4 兼容形式：拆回 v4 复判
		return IsPublicIPv4(v4.String())
	}
	if parsed.IsUnspecified() || parsed.IsLoopback() {
		return false // :: / ::1（展开形式同样命中）
	}
	if parsed.IsLinkLocalUnicast() {
		return false // fe80::/10
	}
	if parsed.IsPrivate() {
		return false // fc00::/7 ULA
	}
	if parsed.IsMulticast() {
		return false // ff00::/8
	}
	if strings.HasPrefix(strings.ToLower(ip), "64:ff9b") {
		return false // NAT64 已知前缀，保守拒绝
	}
	return true
}

// AssertResolvesPublic DNS 复检：任一解析结果不公开即拒绝（防域名指内网的绕行）。
func AssertResolvesPublic(hostname string) error {
	addrs, err := net.LookupIP(hostname)
	if err != nil {
		return fmt.Errorf("错误：%s 解析失败：%s（已拦截，SSRF 防护）", hostname, err)
	}
	if len(addrs) == 0 {
		return fmt.Errorf("错误：%s 没有解析到任何地址", hostname)
	}
	for _, addr := range addrs {
		public := IsPublicIPv6(addr.String())
		if v4 := addr.To4(); v4 != nil {
			public = IsPublicIPv4(v4.String())
		}
		if !public {
			return fmt.Errorf("错误：%s 解析到私有/保留地址 %s（已拦截，SSRF 防护）", hostname, addr.String())
		}
	}
	return nil
}
