namespace ccode.kernel;

public static class AppVersion
{
    public const string Version = "0.1.0";
}

/// <summary>core/session.SessionStore 满足此结构（kernel 不直接依赖 core，用结构化接口注入）。</summary>
public interface ISessionStore
{
    void Start(IReadOnlyDictionary<string, object?>? meta = null);
    void Append(ChatMessage message);
    List<SessionSummary> ListRecent(int n);
    List<ChatMessage> Load(string file);
}

/// <summary>会话列表条目：文件绝对路径 + 修改时间（epoch 毫秒）+ 首条用户输入标签。</summary>
public sealed record SessionSummary(string File, long MtimeMs, string Label);

/// <summary>
/// App：插件的运行环境——命令与壳通过它拿能力，彼此互不 import。
/// kernel 不 import core：store 与 freshMessages 由装配方（Program）注入。
/// </summary>
public sealed class App
{
    private readonly Func<List<ChatMessage>> _freshMessages;

    public Config Config { get; }
    public Registry Registry { get; }
    public IChatClient Provider { get; }
    public ISessionStore Store { get; }
    public YoloRef Yolo { get; }

    /// <summary>当前会话消息；命令/壳直接读写这个列表。</summary>
    public List<ChatMessage> Messages { get; set; } = [];

    public App(Config config, Registry registry, bool yolo,
        Func<List<ChatMessage>> freshMessages, ISessionStore store)
    {
        Config = config;
        Registry = registry;
        _freshMessages = freshMessages;
        Store = store;
        Yolo = new YoloRef(yolo);
        Provider = SelectProvider(config, registry);
        ResetMessages();
        StartSession();
    }

    /// <summary>开新会话文件（/new、/resume 都换文件，永不追加旧文件）。</summary>
    public void StartSession(IReadOnlyDictionary<string, object?>? extra = null)
    {
        var meta = new Dictionary<string, object?>
        {
            ["version"] = AppVersion.Version,
            ["model"] = Config.Model,
            ["cwd"] = Directory.GetCurrentDirectory(),
            ["yolo"] = Yolo.Value,
        };
        if (extra != null)
            foreach (var (key, value) in extra)
                meta[key] = value;
        Store.Start(meta);
    }

    /// <summary>messages 换成全新 system 数组。</summary>
    public void ResetMessages() => Messages = _freshMessages();

    /// <summary>显式配置的 protocol 按名选；否则按注册顺序取首个 Matches 命中的 provider。</summary>
    internal static IChatClient SelectProvider(Config config, Registry registry)
    {
        if (config.Protocol is { } protocol)
        {
            var explicitHit = registry.Providers().FirstOrDefault(p => p.Name == protocol);
            if (explicitHit is null)
                throw new InvalidOperationException(
                    $"没有名为 {protocol} 的 provider 插件（可用：{string.Join(", ", registry.Providers().Select(p => p.Name))}）");
            return explicitHit.Create(config);
        }
        var hit = registry.Providers().FirstOrDefault(p => p.Matches(config.BaseUrl));
        if (hit is null)
            throw new InvalidOperationException($"没有 provider 插件能处理 BASE_URL：{config.BaseUrl}");
        return hit.Create(config);
    }
}
