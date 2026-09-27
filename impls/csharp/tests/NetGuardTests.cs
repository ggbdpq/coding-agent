using ccode.plugins.tools;

namespace ccode.tests;

/// <summary>TDD 切片3：NetGuard 纯函数判定表（含 IPv6 展开形式、::ffff: 映射私网、非法 IP）。</summary>
internal static class NetGuardTests
{
    public static void All()
    {
        Runner.Case("netguard：http/https 之外的协议拒绝", () =>
        {
            var check = NetGuard.CheckUrlLiteral("ftp://example.com/x");
            Check.True(!check.Ok, "ftp 应拒绝");
            Check.Contains("只允许 http/https", check.Reason ?? "", "提示语");
        });
        Runner.Case("netguard：无法解析的 URL 拒绝", () =>
        {
            Check.True(!NetGuard.CheckUrlLiteral("not a url").Ok, "应拒绝");
        });
        Runner.Case("netguard：保留域名拒绝", () =>
        {
            foreach (var host in new[] { "localhost", "a.localhost", "api.internal", "box.local" })
                Check.True(!NetGuard.CheckUrlLiteral($"http://{host}/").Ok, $"{host} 应拒绝");
        });
        Runner.Case("netguard：IPv4 私有/保留段拒绝，段边界放行", () =>
        {
            foreach (var ip in new[]
            {
                "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.1.1",
                "172.16.0.1", "172.31.255.255", "192.168.1.1",
                "100.64.0.1", "100.127.255.255",
                "198.18.0.1", "198.19.255.255", "224.0.0.1", "255.255.255.255",
            })
                Check.True(!NetGuard.CheckUrlLiteral($"http://{ip}/").Ok, $"{ip} 应拒绝");
            foreach (var ip in new[] { "8.8.8.8", "172.32.0.1", "100.128.0.1", "198.20.0.1", "192.169.0.1" })
                Check.True(NetGuard.CheckUrlLiteral($"http://{ip}/").Ok, $"{ip} 应放行");
        });
        Runner.Case("netguard：IPv6 环回/未指定/链路本地/ULA/NAT64 拒绝", () =>
        {
            foreach (var ip in new[]
            {
                "[::1]", "[::]", "[fe80::1]", "[febf::1]", "[0:0:0:0:0:0:0:1]",
                "[fd12::1]", "[fc00::1]", "[64:ff9b::1.2.3.4]",
            })
                Check.True(!NetGuard.CheckUrlLiteral($"http://{ip}/").Ok, $"{ip} 应拒绝");
        });
        Runner.Case("netguard：IPv4 映射形式按映射后的 v4 复判", () =>
        {
            Check.True(!NetGuard.CheckUrlLiteral("http://[::ffff:192.168.1.1]/").Ok, "::ffff:192.168.1.1 应拒绝");
            Check.True(!NetGuard.CheckUrlLiteral("http://[::ffff:c0a8:101]/").Ok, "十六进制映射 192.168.1.1 应拒绝");
            Check.True(NetGuard.CheckUrlLiteral("http://[::ffff:8.8.8.8]/").Ok, "::ffff:8.8.8.8 应放行");
        });
        Runner.Case("netguard：公网 IPv6 放行", () =>
        {
            Check.True(NetGuard.CheckUrlLiteral("http://[2001:4860:4860::8888]/").Ok, "公网 IPv6 应放行");
        });
        Runner.Case("netguard：IsPublicIpv4 判定表（含非法输入保守拒绝）", () =>
        {
            foreach (var (ip, isPublic) in new[]
            {
                ("8.8.8.8", true), ("1.2.3.4", true),
                ("10.0.0.1", false), ("127.0.0.1", false),
                ("172.15.0.1", true), ("172.16.0.1", false), ("172.31.255.255", false), ("172.32.0.1", true),
                ("192.168.0.1", false), ("192.169.0.1", true),
                ("100.63.255.255", true), ("100.64.0.0", false), ("100.127.255.255", false), ("100.128.0.0", true),
                ("198.17.255.255", true), ("198.18.0.0", false), ("198.19.0.0", false), ("198.20.0.0", true),
                ("239.1.1.1", false), ("240.0.0.1", false),
                ("256.1.1.1", false), ("abc", false), ("1.2.3", false), ("999", false),
            })
                Check.Eq(isPublic, NetGuard.IsPublicIpv4(ip), $"IsPublicIpv4({ip})");
        });
        Runner.Case("netguard：IsPublicIpv6 判定表（含展开与映射形式、非法 IP）", () =>
        {
            foreach (var (ip, isPublic) in new[]
            {
                ("::1", false), ("::", false), ("0:0:0:0:0:0:0:1", false), // 展开形式的环回
                ("fe80::1", false), ("febf:ffff::1", false), ("fec0::1", true),
                ("fc00::1", false), ("fd12:3456::1", false),
                ("::ffff:10.0.0.1", false), ("::ffff:8.8.8.8", true), ("::ffff:c0a8:101", false),
                ("2001:4860:4860::8888", true), ("64:ff9b::7f00:1", false),
                ("garbage", false), ("8.8.8.8", false), ("", false), (":::zzz", false),
            })
                Check.Eq(isPublic, NetGuard.IsPublicIpv6(ip), $"IsPublicIpv6({ip})");
        });
        Runner.Case("netguard：DNS 复检拦截环回解析（仅用本机 localhost，不出网）", () =>
        {
            Check.Throws<Exception>(
                () => NetGuard.AssertResolvesPublicAsync("localhost", CancellationToken.None)
                    .GetAwaiter().GetResult());
        });
    }
}
