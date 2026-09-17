using System.Text.Json.Nodes;

namespace ccode.kernel;

/// <summary>配置：环境变量 &gt; ~/.ccode/config.json &gt; 报错指路。</summary>
public sealed class Config
{
    public string ApiKey { get; init; } = "";
    public string BaseUrl { get; init; } = "";
    public string Model { get; init; } = "";

    /// <summary>仅显式配置（CCODE_PROTOCOL / config.json）时非空；否则由 provider 插件按 URL 自动识别。</summary>
    public string? Protocol { get; init; }

    /// <summary>估算 token 上限，超过即触发上下文裁剪。</summary>
    public int ContextLimit { get; init; } = 100_000;

    /// <summary>~/.ccode 目录，配置/会话/全局指令都住这里。</summary>
    public string CcodeDir { get; init; } = "";
}

/// <summary>配置加载：刻意不写死任何默认端点/模型——本地优先工具，用户自己决定请求发去哪。</summary>
public static class ConfigLoader
{
    private sealed record FileConfig(string? ApiKey, string? BaseUrl, string? Model, string? Protocol);

    /// <summary>
    /// 用户主目录：与 tcode 的 homedir() 同语义——优先读环境变量，
    /// 这样测试可以把 HOME/USERPROFILE 指到隔离目录（GetFolderPath 在 Windows 走
    /// SHGetKnownFolderPath，不认环境变量重定向）。
    /// </summary>
    public static string HomeDir()
    {
        var userProfile = Environment.GetEnvironmentVariable("USERPROFILE");
        if (!string.IsNullOrEmpty(userProfile)) return userProfile;
        var home = Environment.GetEnvironmentVariable("HOME");
        if (!string.IsNullOrEmpty(home)) return home;
        return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    public static Config Load()
    {
        var ccodeDir = Path.Combine(HomeDir(), ".ccode");
        var fileConfig = ReadJsonConfig(Path.Combine(ccodeDir, "config.json"));

        var apiKey = Environment.GetEnvironmentVariable("CCODE_API_KEY") ?? fileConfig.ApiKey ?? "";
        var baseUrl = (Environment.GetEnvironmentVariable("CCODE_BASE_URL") ?? fileConfig.BaseUrl ?? "").TrimEnd('/');
        var model = Environment.GetEnvironmentVariable("CCODE_MODEL") ?? fileConfig.Model ?? "";

        var contextLimit = 100_000;
        var rawLimit = Environment.GetEnvironmentVariable("CCODE_CONTEXT_LIMIT");
        if (long.TryParse(rawLimit, out var parsedLimit) && parsedLimit > 0)
            contextLimit = (int)Math.Min(parsedLimit, int.MaxValue);

        var rawProtocol = (Environment.GetEnvironmentVariable("CCODE_PROTOCOL") ?? fileConfig.Protocol ?? "")
            .ToLowerInvariant();
        string? protocol = null;
        if (rawProtocol.Length > 0)
        {
            if (rawProtocol is not ("openai" or "anthropic"))
                throw new InvalidOperationException($"CCODE_PROTOCOL 只能是 openai 或 anthropic，收到：{rawProtocol}");
            protocol = rawProtocol;
        }

        var missing = new List<string>();
        if (apiKey.Length == 0) missing.Add("CCODE_API_KEY");
        if (baseUrl.Length == 0) missing.Add("CCODE_BASE_URL");
        if (model.Length == 0) missing.Add("CCODE_MODEL");
        if (missing.Count > 0)
        {
            throw new InvalidOperationException(
                $"缺少模型配置：{string.Join("、", missing)}。\n" +
                "设置方式（二选一）：\n" +
                "  1. 环境变量：export CCODE_API_KEY=sk-xxx CCODE_BASE_URL=https://xxx/v1 CCODE_MODEL=模型名\n" +
                "  2. 配置文件：~/.ccode/config.json 写 {\"apiKey\":\"...\",\"baseUrl\":\"...\",\"model\":\"...\"}\n" +
                "任何 OpenAI 兼容端点都可以（本地中转、云 API 均可）。");
        }

        return new Config
        {
            ApiKey = apiKey,
            BaseUrl = baseUrl,
            Model = model,
            Protocol = protocol,
            ContextLimit = contextLimit,
            CcodeDir = ccodeDir,
        };
    }

    private static FileConfig ReadJsonConfig(string file)
    {
        if (!File.Exists(file)) return new FileConfig(null, null, null, null);
        try
        {
            var node = JsonNode.Parse(File.ReadAllText(file));
            return new FileConfig(
                (string?)node?["apiKey"],
                (string?)node?["baseUrl"],
                (string?)node?["model"],
                (string?)node?["protocol"]);
        }
        catch (Exception e)
        {
            throw new InvalidOperationException($"~/.ccode/config.json 解析失败：{e.Message}");
        }
    }
}
