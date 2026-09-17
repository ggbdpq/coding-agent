// 网络守卫：web_fetch 的 SSRF 防线（实现即验收条件）。
// 规则：仅 http/https；拒绝会解析到环回/私有/保留地址的主机；重定向逐跳复检。
// 纯函数部分（协议/字面 IP/URL 解析）独立导出方便单测，DNS 部分单独一个入口。
// IPv6 用 std::net 解析（天然覆盖展开形式），::ffff: 映射地址拆回 v4 复判，
// 不靠字符串形状。URL 解析手写最小子集（依赖政策：不引 url crate）。

use std::net::{IpAddr, Ipv6Addr, ToSocketAddrs};

/// URL 字面校验结果：ok 时携带解析出的 URL（供 webfetch 发请求与跟随重定向）。
/// port/path 保留在解析结果里供诊断与测试（请求直接用 raw）。
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ParsedUrl {
    /// 完整 URL 字符串（请求直接用它）
    pub raw: String,
    pub scheme: String,
    /// 小写、去方括号的主机名
    pub host: String,
    pub port: Option<u16>,
    /// host[:port]（IPv6 带方括号），拼接相对重定向用
    pub authority: String,
    /// 以 / 开头的路径部分（可含 ?#）
    pub path: String,
}

/// 协议与主机名字面校验（不含 DNS）。
pub fn check_url_literal(raw: &str) -> Result<ParsedUrl, String> {
    let url = parse_url(raw).ok_or_else(|| "错误：URL 无法解析".to_string())?;
    if url.scheme != "http" && url.scheme != "https" {
        return Err(format!("错误：只允许 http/https 协议，收到 {}:", url.scheme));
    }
    if url.host.is_empty() {
        return Err("错误：URL 缺少主机名".to_string());
    }
    if is_literal_blocked(&url.host) {
        return Err(format!("错误：拒绝访问私有/保留地址：{}（已拦截，SSRF 防护）", url.host));
    }
    Ok(url)
}

/// 主机名是字面 IP 或保留域名时的直接判定；普通域名返回 false（交给 DNS 复检）。
fn is_literal_blocked(host: &str) -> bool {
    let h = host.to_lowercase();
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".internal") || h.ends_with(".local") {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(_)) => !is_public_ipv4_str(&h),
        Ok(IpAddr::V6(_)) => !is_public_ipv6_str(&h),
        Err(_) => false,
    }
}

/// 是否公网 IPv4（点分字符串形式）。非法输入一律不公开。
pub fn is_public_ipv4_str(ip: &str) -> bool {
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut octets = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        let v: u32 = p.parse().unwrap_or(999);
        if v > 255 {
            return false;
        }
        octets[i] = v as u8;
    }
    is_public_ipv4_octets(octets)
}

/// 是否公网 IPv4。覆盖常见保留段；清单取向是"保守拒绝"。
pub fn is_public_ipv4_octets(o: [u8; 4]) -> bool {
    let (a, b) = (o[0], o[1]);
    !(a == 0 || a == 10 || a == 127 // 本网络 / 私有 / 环回
        || (a == 169 && b == 254) // 链路本地（云元数据端点）
        || (a == 172 && (16..=31).contains(&b)) // 私有
        || (a == 192 && b == 168) // 私有
        || (a == 100 && (64..=127).contains(&b)) // CGNAT
        || (a == 198 && (b == 18 || b == 19)) // 基准测试
        || a >= 224) // 组播 + 保留 + 广播
}

/// 是否公网 IPv6（字符串形式，接受缩写/展开/映射写法）。非法保守拒绝。
pub fn is_public_ipv6_str(ip: &str) -> bool {
    match ip.parse::<Ipv6Addr>() {
        Ok(v6) => is_public_ipv6_addr(&v6),
        Err(_) => false,
    }
}

/// 是否公网 IPv6。IPv4 映射形式拆回 v4 复判；环回/未指定/链路本地/ULA/组播拒绝；
/// 其余保守放行。
pub fn is_public_ipv6_addr(v6: &Ipv6Addr) -> bool {
    // ::ffff:x.y.z.w 及其十六进制展开形式（如 0:0:0:0:0:ffff:c0a8:1）：拆回 v4 复判
    if let Some(v4) = v6.to_ipv4_mapped() {
        return is_public_ipv4_octets(v4.octets());
    }
    let o = v6.octets();
    if v6.is_loopback() || v6.is_unspecified() {
        return false; // ::1 / ::
    }
    if o[0] == 0xfe && (o[1] & 0xc0) == 0x80 {
        return false; // fe80::/10 链路本地（字节判，不依赖不稳定谓词）
    }
    if o[0] == 0xfc || o[0] == 0xfd {
        return false; // fc00::/7 ULA
    }
    if v6.is_multicast() {
        return false; // ff00::/8
    }
    if o[0] == 0x00 && o[1] == 0x64 && o[2] == 0xff && o[3] == 0x9b && o[4..12].iter().all(|&b| b == 0) {
        return false; // 64:ff9b::/96 NAT64 已知前缀，保守拒绝
    }
    true
}

/// 是否公网地址（v4/v6 统一入口），DNS 复检用。
pub fn is_public_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_ipv4_octets(v4.octets()),
        IpAddr::V6(v6) => is_public_ipv6_addr(v6),
    }
}

/// DNS 复检：任一解析结果不公开即拒绝（防域名指内网的绕行）。
pub fn assert_resolves_public(hostname: &str) -> Result<(), String> {
    let addrs: Vec<IpAddr> = match (hostname, 443).to_socket_addrs() {
        Ok(it) => it.map(|s| s.ip()).collect(),
        Err(e) => return Err(format!("错误：{} 解析失败：{}（已拦截，SSRF 防护）", hostname, e)),
    };
    if addrs.is_empty() {
        return Err(format!("错误：{} 没有解析到任何地址", hostname));
    }
    for a in &addrs {
        if !is_public_ip(a) {
            return Err(format!("错误：{} 解析到私有/保留地址 {}（已拦截，SSRF 防护）", hostname, a));
        }
    }
    Ok(())
}

/// 解析绝对 URL 的最小子集：scheme://[userinfo@]host[:port]/path?query#fragment。
/// 非法/无 authority 形态返回 None（WHATWG 的 http:///no-host 特例在 check_url_literal 兜底）。
pub(crate) fn parse_url(raw: &str) -> Option<ParsedUrl> {
    let colon = raw.find(':')?;
    let scheme = &raw[..colon];
    let mut sc = scheme.chars();
    let scheme_ok = sc.next().map_or(false, |c| c.is_ascii_alphabetic())
        && sc.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.');
    if !scheme_ok {
        return None;
    }
    let after = raw[colon + 1..].strip_prefix("//")?;
    // authority 到第一个 / ? # 为止
    let auth_end = after.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(after.len());
    let path = {
        let p = &after[auth_end..];
        if p.is_empty() { "/".to_string() } else { p.to_string() }
    };
    let authority_full = &after[..auth_end];
    // userinfo：最后一个 @ 之前的部分丢弃
    let authority = match authority_full.rfind('@') {
        Some(i) => &authority_full[i + 1..],
        None => authority_full,
    };
    // host / port；IPv6 字面量带方括号
    let (host_raw, port) = if let Some(stripped) = authority.strip_prefix('[') {
        let close = stripped.find(']')?;
        let h = &stripped[..close];
        let tail = &stripped[close + 1..];
        let p = if let Some(ps) = tail.strip_prefix(':') {
            Some(ps.parse::<u16>().ok()?)
        } else if tail.is_empty() {
            None
        } else {
            return None;
        };
        (h.to_string(), p)
    } else {
        match authority.rfind(':') {
            Some(i) => {
                let ps = &authority[i + 1..];
                if ps.is_empty() {
                    (authority[..i].to_string(), None)
                } else {
                    (authority[..i].to_string(), Some(ps.parse::<u16>().ok()?))
                }
            }
            None => (authority.to_string(), None),
        }
    };
    let mut host = host_raw.to_lowercase();
    let mut authority_out = authority.to_string();
    if host.is_empty() {
        // WHATWG 兼容：http:///no-host 把首段路径当主机名，字面层放行，由 DNS 复检兜底
        if let Some(seg) = path.strip_prefix('/') {
            let (h, _rest) = seg.split_once('/').unwrap_or((seg, ""));
            if !h.is_empty() {
                host = h.to_lowercase();
                authority_out = host.clone();
            }
        }
    }
    Some(ParsedUrl { raw: raw.to_string(), scheme: scheme.to_lowercase(), host, port, authority: authority_out, path })
}

/// 相对重定向 Location 与当前 URL 拼接（覆盖绝对/协议相对/根相对/?#/相对路径五类）。
pub fn join_redirect(base: &ParsedUrl, loc: &str) -> Option<String> {
    let loc = loc.trim();
    if loc.is_empty() {
        return None;
    }
    // 1. 绝对 URL（自带 scheme）
    if let Some(ci) = loc.find(':') {
        if ci > 0 {
            let s = &loc[..ci];
            let mut it = s.chars();
            if it.next().map_or(false, |c| c.is_ascii_alphabetic())
                && it.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
            {
                return Some(loc.to_string());
            }
        }
    }
    // 2. 协议相对 //host/path
    if let Some(r) = loc.strip_prefix("//") {
        return Some(format!("{}://{}", base.scheme, r));
    }
    // 3. 根相对 /path
    if loc.starts_with('/') {
        return Some(format!("{}://{}{}", base.scheme, base.authority, loc));
    }
    // 4. ?query / #fragment：去掉当前 query/fragment 后拼接
    if loc.starts_with('?') || loc.starts_with('#') {
        let base_no_qf = base.raw.split(['?', '#']).next().unwrap_or("");
        return Some(format!("{}{}", base_no_qf, loc));
    }
    // 5. 相对路径：以当前"目录"为基准，再归一 . 与 ..
    let base_no_qf = base.raw.split(['?', '#']).next().unwrap_or("");
    let dir_end = base_no_qf.rfind('/')? + 1;
    let merged = format!("{}{}", &base_no_qf[..dir_end], loc);
    Some(normalize_dots(&merged))
}

/// 路径段归一：处理 . 与 .. 段（其余部分原样保留）。
fn normalize_dots(url: &str) -> String {
    let path_start = match url.find("://") {
        Some(i) => {
            let auth_start = i + 3;
            match url[auth_start..].find('/') {
                Some(j) => auth_start + j,
                None => return url.to_string(),
            }
        }
        None => 0,
    };
    let (head, tail) = url.split_at(path_start);
    let cut = tail.find(|c| c == '?' || c == '#').unwrap_or(tail.len());
    let (path, suffix) = tail.split_at(cut);
    let mut segs: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "." => {}
            ".." => {
                segs.pop();
            }
            s => segs.push(s),
        }
    }
    format!("{}{}{}", head, segs.join("/"), suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(raw: &str) -> bool {
        check_url_literal(raw).is_err()
    }

    #[test]
    fn 协议白名单_仅http_https() {
        assert!(blocked("ftp://example.com/x"));
        assert!(blocked("file:///etc/passwd"));
        assert!(!blocked("https://example.com/x"));
        assert!(!blocked("http://example.com/x"));
    }

    #[test]
    fn 保留域名与字面内网IP一律拒绝() {
        for raw in [
            "http://localhost/x",
            "http://api.localhost/x",
            "http://svc.internal/x",
            "http://127.0.0.1/x",
            "http://10.0.0.1/x",
            "http://192.168.1.1/x",
            "http://172.16.0.1/x",
            "http://169.254.169.254/meta", // 云元数据端点
            "http://0.0.0.0/x",
            "http://[::1]/x",
            "http://[fd00::1]/x",
            "http://[0:0:0:0:0:0:0:1]/x", // ::1 展开形式
        ] {
            assert!(blocked(raw), "{} 应被拒绝", raw);
        }
    }

    #[test]
    fn 公网地址放行_坏URL拒绝() {
        assert!(!blocked("https://api.deepseek.com/v1"));
        assert!(!blocked("http://8.8.8.8/dns-query"));
        assert!(!blocked("http://[2606:4700::1111]/x"));
        assert!(blocked("not a url"));
        // http:///no-host 会把 no-host 当作普通域名：字面层放行，由 DNS 复检兜底
        assert!(!blocked("http:///no-host"));
    }

    #[test]
    fn 拒绝理由带SSRF标识() {
        let err = check_url_literal("http://127.0.0.1:9/private").unwrap_err();
        assert!(err.contains("已拦截"), "实际：{}", err);
        assert!(err.contains("127.0.0.1"), "实际：{}", err);
    }

    #[test]
    fn is_public_ipv4判定表() {
        assert!(is_public_ipv4_str("8.8.8.8"));
        assert!(is_public_ipv4_str("172.32.0.1")); // 172 段只有 16-31 是私有
        assert!(!is_public_ipv4_str("172.16.0.1"));
        assert!(!is_public_ipv4_str("100.64.0.1")); // CGNAT
        assert!(!is_public_ipv4_str("198.18.0.1")); // 基准测试
        assert!(!is_public_ipv4_str("224.0.0.1")); // 组播
        assert!(!is_public_ipv4_str("256.1.1.1")); // 非法
        assert!(!is_public_ipv4_str("1.2.3")); // 非法
        assert!(!is_public_ipv4_str("1.2.3.4.5")); // 非法
    }

    #[test]
    fn is_public_ipv6判定表_含IPv4映射回拆与展开形式() {
        assert!(is_public_ipv6_str("2606:4700::1111"));
        assert!(is_public_ipv6_str("::ffff:8.8.8.8")); // 映射的公网 v4
        assert!(!is_public_ipv6_str("::ffff:192.168.0.1")); // 映射的私网 v4
        assert!(!is_public_ipv6_str("0:0:0:0:0:ffff:c0a8:1")); // 同上，十六进制展开形式
        assert!(!is_public_ipv6_str("::1"));
        assert!(!is_public_ipv6_str("0:0:0:0:0:0:0:1")); // 环回展开形式
        assert!(!is_public_ipv6_str("::")); // 未指定
        assert!(!is_public_ipv6_str("fe80::1"));
        assert!(!is_public_ipv6_str("fc00::1"));
        assert!(!is_public_ipv6_str("fd12::1"));
        assert!(!is_public_ipv6_str("64:ff9b::1.2.3.4")); // NAT64
        assert!(!is_public_ipv6_str("not-an-ip")); // 非法保守拒绝
    }

    #[test]
    fn url解析主机名与端口() {
        let u = check_url_literal("http://Example.COM:8080/a/b?q=1").unwrap();
        assert_eq!(u.host, "example.com");
        assert_eq!(u.port, Some(8080));
        assert_eq!(u.path, "/a/b?q=1");
        let v6 = check_url_literal("http://[2606:4700::1111]:8443/x").unwrap();
        assert_eq!(v6.host, "2606:4700::1111");
        assert_eq!(v6.port, Some(8443));
    }

    #[test]
    fn 相对重定向拼接() {
        let base = check_url_literal("https://example.com/a/b/c").unwrap();
        assert_eq!(join_redirect(&base, "https://other.net/x").as_deref(), Some("https://other.net/x"));
        assert_eq!(join_redirect(&base, "//other.net/x").as_deref(), Some("https://other.net/x"));
        assert_eq!(join_redirect(&base, "/root").as_deref(), Some("https://example.com/root"));
        assert_eq!(join_redirect(&base, "d/e").as_deref(), Some("https://example.com/a/b/d/e"));
        assert_eq!(join_redirect(&base, "../up").as_deref(), Some("https://example.com/a/up"));
        assert_eq!(join_redirect(&base, "?q=2").as_deref(), Some("https://example.com/a/b/c?q=2"));
    }
}
