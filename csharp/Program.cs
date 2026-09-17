// 入口：装配——注册内置插件 → 创建 App → 起 shell。缺配置给中文指路，不甩堆栈。
using System.Text;
using ccode.core;
using ccode.kernel;
using ccode.plugins;

// 输出统一 UTF-8（不经控制台代码页）：Windows 默认 OEM 代码页会打碎中文与提示符
Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), Ui.Utf8NoBom) { AutoFlush = true });
try { Console.InputEncoding = Encoding.UTF8; }
catch { /* stdin 重定向时可能不可设，忽略 */ }

const string usage = """
    ccode —— 极简本地优先 coding agent

    用法：ccode [--yolo] [--help] [--version]

      --yolo     跳过写文件/执行命令的逐次确认（会话内可用 /yolo 切换）
      --help     显示本帮助
      --version  显示版本

    环境变量：CCODE_API_KEY / CCODE_BASE_URL / CCODE_MODEL / CCODE_PROTOCOL（或写 ~/.ccode/config.json）
    """;

if (args.Contains("--help") || args.Contains("-h"))
{
    Console.WriteLine(usage);
    return 0;
}
if (args.Contains("--version"))
{
    Console.WriteLine($"ccode v{AppVersion.Version}");
    return 0;
}
var yolo = args.Contains("--yolo");
var extra = args.Where(a => !a.StartsWith("--")).ToArray();
if (extra.Length > 0)
    Console.WriteLine($"提示：ccode 目前只支持交互式使用，忽略多余参数：{string.Join(" ", extra)}");

try
{
    var config = ConfigLoader.Load();
    var registry = PluginList.Build();
    var app = new App(
        config,
        registry,
        yolo,
        () => [ChatMessage.System(SystemPrompt.Build(Directory.GetCurrentDirectory()))],
        new SessionStore(Path.Combine(config.CcodeDir, "sessions")));
    var shell = registry.Shell("repl") ?? throw new InvalidOperationException("找不到 shell 插件：repl");
    await shell.StartAsync(app);
}
catch (Exception e)
{
    Console.Error.WriteLine($"启动失败：{e.Message}");
    return 1;
}
return 0;
