using System.Text.Json.Nodes;
using ccode.kernel;
using ccode.plugins.commands;
using ccode.plugins.tools;

namespace ccode.tests;

/// <summary>
/// 审批策略与写白名单单测（R4）：config.AllowWriteDirs 内的 write/edit 免确认，外必问，
/// 未配置一律确认。镜像 tcode/test/approval.test.ts。
/// </summary>
internal static class ApprovalTests
{
    private sealed class FakeStore : ISessionStore
    {
        public void Start(IReadOnlyDictionary<string, object?>? meta = null) { }
        public void Append(ChatMessage message) { }
        public List<SessionSummary> ListRecent(int n) => [];
        public List<ChatMessage> Load(string file) => [];
    }

    private sealed class DummyProvider : ProviderPlugin
    {
        public override string Name => "fake";
        public override bool Matches(string baseUrl) => true;
        public override IChatClient Create(Config config) => null!;
    }

    private static App FakeApp(List<string>? allowWriteDirs = null)
    {
        var registry = new Registry().Register(new DummyProvider());
        return new App(
            new Config
            {
                ApiKey = "k",
                BaseUrl = "http://127.0.0.1",
                Model = "fake",
                ContextLimit = 1_000_000,
                AllowWriteDirs = allowWriteDirs ?? [],
            },
            registry,
            yolo: false,
            () => [ChatMessage.System("s")],
            new FakeStore());
    }

    private static JsonObject FilePathArgs(string file) => new() { ["file_path"] = file };

    public static void All()
    {
        var cwd = Directory.GetCurrentDirectory();

        Runner.Case("白名单：write 路径在 allowWriteDirs 内 → 免确认", () =>
        {
            var app = FakeApp([Path.Combine(cwd, "build")]);
            var target = Path.Combine(cwd, "build", "out.txt");
            Check.True(new WriteTool().SkipPermission(FilePathArgs(target), app),
                "白名单内的写入应免确认");
        });

        Runner.Case("白名单：write 路径在 allowWriteDirs 外 → 仍需确认", () =>
        {
            var app = FakeApp([Path.Combine(cwd, "build")]);
            var target = Path.Combine(cwd, "src", "out.txt");
            Check.True(!new WriteTool().SkipPermission(FilePathArgs(target), app),
                "白名单外的写入仍应逐次确认");
        });

        Runner.Case("白名单：未配置 allowWriteDirs → 一律确认（含 write）", () =>
        {
            var app = FakeApp();
            var target = Path.Combine(cwd, "whatever.txt");
            Check.True(!new WriteTool().SkipPermission(FilePathArgs(target), app),
                "未配置白名单时应逐次确认");
        });

        Runner.Case("白名单：edit 白名单内免确认、白名单外仍确认", () =>
        {
            var tool = new EditTool();
            var inside = FakeApp([cwd]);
            Check.True(tool.SkipPermission(FilePathArgs(Path.Combine(cwd, "a.cs")), inside),
                "白名单内的编辑应免确认");
            var outside = FakeApp([Path.Combine(cwd, "build")]);
            Check.True(!tool.SkipPermission(FilePathArgs(Path.Combine(cwd, "a.cs")), outside),
                "白名单外的编辑仍应逐次确认");
        });

        Runner.Case("白名单：相对路径按 cwd 归一化后判定", () =>
        {
            var app = FakeApp([Path.Combine(cwd, "build")]);
            Check.True(new WriteTool().SkipPermission(FilePathArgs(Path.Combine("build", "out.txt")), app),
                "相对路径归一化后落在白名单内应免确认");
        });

        Runner.Case("/approval never：运行时改策略并开启免确认；normal 切回", () =>
        {
            var app = FakeApp();
            new ApprovalCommand().RunAsync(app, ["never"]).GetAwaiter().GetResult();
            Check.Eq("never", app.Config.Approval, "Config.Approval 应更新");
            Check.True(app.Yolo.Value, "never 应同步开启会话免确认");

            new ApprovalCommand().RunAsync(app, ["normal"]).GetAwaiter().GetResult();
            Check.Eq("normal", app.Config.Approval, "Config.Approval 应切回");
            Check.True(!app.Yolo.Value, "normal 应恢复逐次确认");
        });
    }
}
