// 入口：装配——注册内置插件 → 创建 App → 起 shell（repl）或无交互执行（exec）。
// 缺配置给中文指路，不甩堆栈。
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

    用法：ccode [exec "任务"] [--continue] [--yolo] [--help] [--version]

      exec "任务"  无交互执行单个任务后退出（CI/脚本用；必须配合 --yolo）
      --continue  启动时恢复最近一次会话
      --yolo      跳过写文件/执行命令的逐次确认（会话内可用 /yolo 切换）
      --help      显示本帮助
      --version   显示版本

    环境变量：CCODE_API_KEY / CCODE_BASE_URL / CCODE_MODEL / CCODE_PROTOCOL / CCODE_APPROVAL
              （或写 ~/.ccode/config.json）
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
var continueFlag = args.Contains("--continue");
var positional = args.Where(a => !a.StartsWith('-')).ToArray();
var shellName = positional.Length > 0 && positional[0] == "exec" ? "exec" : "repl";
var rest = shellName == "exec" ? positional[1..] : positional;
if (shellName == "repl" && rest.Length > 0)
    Console.WriteLine($"提示：忽略多余参数：{string.Join(" ", rest)}");

try
{
    var config = ConfigLoader.Load();
    var registry = PluginList.Build();
    var app = new App(
        config,
        registry,
        yolo || config.Approval == "never",
        () => [ChatMessage.System(SystemPrompt.Build(Directory.GetCurrentDirectory()))],
        new SessionStore(Path.Combine(config.CcodeDir, "sessions")));

    // --continue：恢复最近一次会话（非 system 消息入列，新内容写进新会话文件）
    if (continueFlag)
    {
        var latest = app.Store.ListRecent(1).FirstOrDefault();
        if (latest is not null)
        {
            var loaded = app.Store.Load(latest.File).Where(m => m.Role != "system").ToList();
            app.Messages.AddRange(loaded);
            app.StartSession(new Dictionary<string, object?>
            {
                ["resumedFrom"] = Path.GetFileName(latest.File),
            });
            Console.WriteLine($"已恢复最近会话（{loaded.Count} 条消息）。");
        }
        else
        {
            Console.WriteLine("没有可恢复的会话，从新会话开始。");
        }
    }

    if (shellName == "exec")
    {
        if (!app.Yolo.Value)
            throw new InvalidOperationException("exec 模式必须配合 --yolo（无交互环境无法逐次确认写操作）");
        var task = AtRefs.ExpandAtRefs(string.Join(" ", rest).Trim(), AtRefs.CappedRead);
        if (task.Length == 0)
            throw new InvalidOperationException("exec 需要任务描述：ccode exec \"任务\"");
        var failed = false;
        try
        {
            await Turn.RunUserTurnAsync(app, task, new TurnHooks
            {
                // exec 必须 yolo：无交互环境无法逐次确认，Check 留空 = 全放行
                Emit = ev =>
                {
                    switch (ev)
                    {
                        case AgentEvent.TextDelta delta:
                            Console.Out.Write(delta.Delta);
                            break;
                        case AgentEvent.ToolCall call:
                        {
                            var argsJson = call.Args.ToJsonString();
                            Console.WriteLine($"\n[tool] {call.Name} {argsJson[..Math.Min(160, argsJson.Length)]}");
                            break;
                        }
                        case AgentEvent.ToolResult result:
                            Console.WriteLine($"[result] {result.Summary.Split('\n')[0]} ({result.Ms}ms)");
                            break;
                        case AgentEvent.TurnEnd end when end.Reason != TurnEndReason.Completed:
                            Console.Error.WriteLine($"\n[turn:{end.Reason.ToString().ToLowerInvariant()}]{end.Error ?? ""}");
                            failed = true;
                            break;
                    }
                },
            }, CancellationToken.None);
            Console.Out.Write("\n");
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"错误：{e.Message}");
            failed = true;
        }
        return failed ? 1 : 0;
    }

    var shell = registry.Shell(shellName) ?? throw new InvalidOperationException($"找不到 shell 插件：{shellName}");
    await shell.StartAsync(app);
}
catch (Exception e)
{
    Console.Error.WriteLine($"启动失败：{e.Message}");
    return 1;
}
return 0;
