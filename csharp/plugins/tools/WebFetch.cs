using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ccode.kernel;
using ccode.providers;

namespace ccode.plugins.tools;

/// <summary>web_fetch 工具：抓取公网页面文本，供模型查文档/API 说明。
/// 安全三道闸（实现即验收条件）：仅 http/https；字面与 DNS 双重拒绝私有/保留地址；
/// 重定向不自动跟随——每跳重新过守卫，杜绝"公网 302 跳内网"。</summary>
public sealed class WebFetchTool : ToolPlugin
{
    private const long MaxBytes = 512 * 1024;
    private const int DefaultMaxChars = 8000;
    private const int MaxRedirects = 5;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    public override string Name => "web_fetch";
    public override string Description =>
        "抓取一个公网 URL 的页面文本（仅 http/https）。用于查阅文档、API 说明、报错线索；内网/私有地址会被拒绝。";
    public override JsonObject? Parameters => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["url"] = new JsonObject { ["type"] = "string", ["description"] = "完整的 http(s) URL" },
            ["max_chars"] = new JsonObject
            {
                ["type"] = "number",
                ["description"] = $"返回正文最大字符数，默认 {DefaultMaxChars}",
            },
        },
        ["required"] = new JsonArray("url"),
    };
    public override bool NeedsPermission => true;
    public override string Preview(JsonObject args) => $"GET {JsonUtil.Str(args["url"]) ?? ""}（出站网络请求）";

    public override async Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken)
    {
        var raw = JsonUtil.Str(args["url"]) ?? "";
        var check = NetGuard.CheckUrlLiteral(raw);
        if (!check.Ok) return check.Reason ?? "错误：URL 不合规";
        var current = check.Url!;

        // 20s 总预算（连接+重定向+正文）；与用户取消令牌链在一起，Ctrl+C 随时可打断
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(Timeout);

        HttpResponseMessage? response = null;
        try
        {
            // 手动跟随重定向：每一跳都重新过字面 + DNS 守卫
            for (var hop = 0; hop <= MaxRedirects; hop++)
            {
                var hopCheck = NetGuard.CheckUrlLiteral(current.ToString());
                if (!hopCheck.Ok) return hopCheck.Reason ?? "错误：重定向目标不合规";
                try
                {
                    await NetGuard.AssertResolvesPublicAsync(current.DnsSafeHost, timeoutCts.Token);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    throw new Exception("错误：请求失败：DNS 解析超时");
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    return e.Message;
                }

                try
                {
                    response = await SharedHttp.Client.GetAsync(
                        current, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    throw new Exception("错误：请求失败：连接或读取超时（20s）");
                }
                catch (Exception e)
                {
                    throw new Exception($"错误：请求失败：{e.Message}");
                }

                if ((int)response.StatusCode is >= 300 and < 400)
                {
                    var location = response.Headers.Location;
                    if (location is null) break;
                    response.Dispose();
                    response = null;
                    current = new Uri(current, location);
                    continue;
                }
                break;
            }

            if (response is null) return "错误：请求未发出";
            if (!response.IsSuccessStatusCode)
                return $"错误：HTTP {(int)response.StatusCode} {response.ReasonPhrase}";

            // 正文封顶 512KB
            await using var stream = await response.Content.ReadAsStreamAsync(timeoutCts.Token);
            var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(chunk, timeoutCts.Token)) > 0)
            {
                buffer.Write(chunk, 0, read);
                if (buffer.Length >= MaxBytes) break;
            }
            var body = Encoding.UTF8.GetString(buffer.ToArray());

            var contentType = response.Content.Headers.ContentType?.ToString() ?? "";
            var text = contentType.Contains("html", StringComparison.OrdinalIgnoreCase)
                ? HtmlToText(body)
                : body;
            var max = Math.Max(200, JsonUtil.Int(args["max_chars"], DefaultMaxChars));
            var note = text.Length > max ? $"\n…（已截断，原文 {text.Length} 字符，可用 max_chars 调大）" : "";
            return $"HTTP {(int)response.StatusCode} · {(contentType.Length > 0 ? contentType : "未知类型")} · {current}\n\n" +
                   $"{text[..Math.Min(max, text.Length)]}{note}";
        }
        finally
        {
            response?.Dispose();
        }
    }

    /// <summary>极简 HTML→文本：去 script/style 与标签。不做实体全解码，够模型读即可。</summary>
    internal static string HtmlToText(string html)
    {
        var withoutScript = Regex.Replace(html, "<script[\\s\\S]*?</script>", " ", RegexOptions.IgnoreCase);
        var withoutStyle = Regex.Replace(withoutScript, "<style[\\s\\S]*?</style>", " ", RegexOptions.IgnoreCase);
        var withoutTags = Regex.Replace(withoutStyle, "<[^>]+>", " ");
        var collapsedSpaces = Regex.Replace(withoutTags, "[ \t]+", " ");
        var collapsedNewlines = Regex.Replace(collapsedSpaces, "\n{3,}", "\n\n");
        return collapsedNewlines.Trim();
    }
}
