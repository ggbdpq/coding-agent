using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.plugins.tools;

public sealed record UrlCheck(bool Ok, string? Reason = null, Uri? Url = null);

/// <summary>
/// 网络守卫：web_fetch 的 SSRF 防线。
/// 规则：仅 http/https；拒绝会解析到环回/私有/保留地址的主机；重定向逐跳复检。
/// 纯函数部分（协议/字面 IP）独立导出方便单测，DNS 部分单独一个入口。
/// IPv6 用 IPAddress.Parse 判定（覆盖展开形式），映射地址 MapToIPv4 拆回 v4 复判。
/// </summary>
public static class NetGuard
{
    /// <summary>协议与主机名字面校验（不含 DNS）。</summary>
    public static UrlCheck CheckUrlLiteral(string raw)
    {
        Uri url;
        try
        {
            url = new Uri(raw); // 默认 UriKind.Absolute：相对形式直接解析失败
        }
        catch
        {
            return new UrlCheck(false, "错误：URL 无法解析");
        }
        if (url.Scheme != "http" && url.Scheme != "https")
            return new UrlCheck(false, $"错误：只允许 http/https 协议，收到 {url.Scheme}");
        // Uri.Host 对 IPv6 字面量保留方括号（如 [::1]），先剥掉
        var host = url.Host.ToLowerInvariant().Trim('[').Trim(']');
        if (host.Length == 0) return new UrlCheck(false, "错误：URL 缺少主机名");
        if (IsLiteralBlocked(host))
            return new UrlCheck(false, $"错误：拒绝访问私有/保留地址：{host}（已拦截，SSRF 防护）");
        return new UrlCheck(true, Url: url);
    }

    /// <summary>主机名是字面 IP 或保留域名时的直接判定；普通域名返回 false（交给 DNS 复检）。</summary>
    internal static bool IsLiteralBlocked(string host)
    {
        var h = host.ToLowerInvariant().Trim('[').Trim(']');
        if (h == "localhost" || h.EndsWith(".localhost") ||
            h.EndsWith(".internal") || h.EndsWith(".local")) return true;
        if (IsDottedQuad(h)) return !IsPublicIpv4(h);
        if (IPAddress.TryParse(h, out var address) &&
            address.AddressFamily == AddressFamily.InterNetworkV6)
            return !IsPublicIpv6(h);
        return false;
    }

    private static bool IsDottedQuad(string s)
    {
        var parts = s.Split('.');
        if (parts.Length != 4) return false;
        foreach (var part in parts)
            if (!byte.TryParse(part, System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture, out _))
                return false;
        return true;
    }

    /// <summary>IPv4 是否公网。覆盖常见保留段；清单取向是"保守拒绝"。非法输入一律判非公网。</summary>
    public static bool IsPublicIpv4(string ip)
    {
        var parts = ip.Split('.');
        if (parts.Length != 4) return false;
        var bytes = new byte[4];
        foreach (var (part, i) in parts.Select((p, i) => (p, i)))
            if (!byte.TryParse(part, System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture, out bytes[i]))
                return false;
        return IsPublicIpv4Bytes(bytes);
    }

    /// <summary>IPv6 是否公网。Parse 后按谓词判定（覆盖展开形式），解析不了保守拒绝。</summary>
    public static bool IsPublicIpv6(string ip)
    {
        if (string.IsNullOrWhiteSpace(ip)) return false;
        if (!IPAddress.TryParse(ip, out var address)) return false;
        if (address.AddressFamily != AddressFamily.InterNetworkV6) return false; // v4 字面量不算公网 v6
        return IsPublicIpv6Address(address);
    }

    /// <summary>IPv6 地址对象判定：环回/未指定/链路本地/ULA/NAT64/映射私网拒绝，其余保守放行。</summary>
    public static bool IsPublicIpv6Address(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
            return IsPublicIpv4Bytes(address.MapToIPv4().GetAddressBytes()); // ::ffff: 拆回 v4 复判
        if (address.Equals(IPAddress.IPv6Loopback) || address.Equals(IPAddress.IPv6Any)) return false;
        if (address.IsIPv6LinkLocal) return false; // fe80::/10 链路本地
        var bytes = address.GetAddressBytes();
        if (bytes.Length != 16) return false;
        if (bytes[0] == 0xfc || bytes[0] == 0xfd) return false;                       // ULA fc00::/7
        // NAT64 已知前缀 64:ff9b::/96（组 0x0064:0xff9b → 字节 00 64 ff 9b），保守拒绝
        if (bytes[0] == 0x00 && bytes[1] == 0x64 && bytes[2] == 0xff && bytes[3] == 0x9b) return false;
        return true;
    }

    private static bool IsPublicIpv4Bytes(byte[] p)
    {
        int a = p[0], b = p[1];
        if (a == 0 || a == 10 || a == 127) return false;                // 本网络 / 私有 / 环回
        if (a == 169 && b == 254) return false;                         // 链路本地
        if (a == 172 && b is >= 16 and <= 31) return false;             // 私有
        if (a == 192 && b == 168) return false;                         // 私有
        if (a == 100 && b is >= 64 and <= 127) return false;            // CGNAT
        if (a == 198 && (b == 18 || b == 19)) return false;             // 基准测试
        if (a >= 224) return false;                                     // 组播 + 保留 + 广播
        return true;
    }

    /// <summary>DNS 复检：任一解析结果不公开即拒绝（防域名指内网的绕行）。</summary>
    public static async Task AssertResolvesPublicAsync(string hostname, CancellationToken cancellationToken)
    {
        var addresses = await Dns.GetHostAddressesAsync(hostname, cancellationToken);
        if (addresses.Length == 0)
            throw new InvalidOperationException($"错误：{hostname} 没有解析到任何地址");
        foreach (var address in addresses)
        {
            var publicAddress = address.AddressFamily switch
            {
                AddressFamily.InterNetwork => IsPublicIpv4Bytes(address.GetAddressBytes()),
                AddressFamily.InterNetworkV6 => IsPublicIpv6Address(address),
                _ => false,
            };
            if (!publicAddress)
                throw new InvalidOperationException(
                    $"错误：{hostname} 解析到私有/保留地址 {address}（已拦截，SSRF 防护）");
        }
    }
}
