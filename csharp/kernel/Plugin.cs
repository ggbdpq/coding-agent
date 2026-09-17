using System.Text.Json.Nodes;

namespace ccode.kernel;

/// <summary>
/// 插件内核：四类插件的抽象基类与注册表。
/// 设计对齐 tcode：统一 Plugin 基类 + Kind 判别；内核只有类型与装配、没有任何行为——
/// "特权核心"最小化，一切能力皆插件。
/// </summary>
public abstract class Plugin
{
    /// <summary>类别：tool / command / provider / shell。</summary>
    public abstract string Kind { get; }

    /// <summary>插件名（kind 内唯一）。</summary>
    public abstract string Name { get; }
}

/// <summary>工具插件：一个文件一个工具（core/agentloop 消费）。</summary>
public abstract class ToolPlugin : Plugin
{
    public override string Kind => "tool";

    public abstract string Description { get; }

    /// <summary>JSON Schema，直传 function calling。</summary>
    public abstract JsonObject? Parameters { get; }

    /// <summary>写类需要逐次确认，读类免确认。</summary>
    public abstract bool NeedsPermission { get; }

    /// <summary>权限确认时展示给用户看的内容。</summary>
    public abstract string Preview(JsonObject args);

    /// <summary>执行工具；错误以"错误：..."文本回流（由 agentloop 统一包一层），取消则抛 OperationCanceledException。</summary>
    public abstract Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken);
}

/// <summary>命令返回值：Exit 时壳收尾退出。</summary>
public sealed record CommandOutcome
{
    public bool Exit { get; init; }
    public static readonly CommandOutcome None = new();
    public static readonly CommandOutcome ExitNow = new() { Exit = true };
}

/// <summary>斜杠命令插件：Name 不含斜杠；输出自己打印。</summary>
public abstract class CommandPlugin : Plugin
{
    public override string Kind => "command";

    public abstract string Usage { get; }

    public abstract string Summary { get; }

    public abstract Task<CommandOutcome> RunAsync(App app, string[] args);
}

/// <summary>协议插件：Matches 按注册顺序首个命中的生效，兜底放清单最后。</summary>
public abstract class ProviderPlugin : Plugin
{
    public override string Kind => "provider";

    public abstract bool Matches(string baseUrl);

    public abstract IChatClient Create(Config config);
}

/// <summary>交互壳插件：REPL/TUI/单发都是并列的壳，一次只起一个。</summary>
public abstract class ShellPlugin : Plugin
{
    public override string Kind => "shell";

    public abstract Task StartAsync(App app);
}

/// <summary>
/// 注册表：插件按 Kind 存取；装配顺序即优先级（provider 的 Matches 首个命中生效）。
/// </summary>
public sealed class Registry
{
    private readonly List<Plugin> _plugins = [];

    public Registry Register(Plugin plugin)
    {
        if (_plugins.Any(existing => existing.Kind == plugin.Kind && existing.Name == plugin.Name))
            throw new InvalidOperationException($"插件重名：{plugin.Kind}/{plugin.Name}");
        _plugins.Add(plugin);
        return this;
    }

    public Registry RegisterAll(IEnumerable<Plugin> plugins)
    {
        foreach (var plugin in plugins) Register(plugin);
        return this;
    }

    public IReadOnlyList<ToolPlugin> Tools() => _plugins.OfType<ToolPlugin>().ToList();

    public IReadOnlyList<ProviderPlugin> Providers() => _plugins.OfType<ProviderPlugin>().ToList();

    public IReadOnlyList<CommandPlugin> Commands() => _plugins.OfType<CommandPlugin>().ToList();

    public ShellPlugin? Shell(string name) =>
        _plugins.OfType<ShellPlugin>().FirstOrDefault(shell => shell.Name == name);

    /// <summary>工具清单 → function calling 的 tools 参数。</summary>
    public List<ToolSchema> ToolSchemas() => ToSchemas(Tools());

    /// <summary>独立导出：core/agentloop 拿到的是裸工具数组，不经注册表实例。</summary>
    public static List<ToolSchema> ToSchemas(IReadOnlyList<ToolPlugin> tools) => tools
        .Select(t => new ToolSchema(t.Name, t.Description, t.Parameters))
        .ToList();
}
