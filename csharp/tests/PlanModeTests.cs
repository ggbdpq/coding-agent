using System.Text.Json.Nodes;
using ccode.core;
using ccode.kernel;

namespace ccode.tests;

/// <summary>
/// Plan Mode 单测：开启时写类工具被拒（引导产出计划）、读类工具不受影响、关闭恢复。
/// 镜像 tcode/test/planmode.test.ts；假 provider/事件收集写法参照 EventTests。
/// </summary>
internal static class PlanModeTests
{
    private sealed class FakeStore : ISessionStore
    {
        public void Start(IReadOnlyDictionary<string, object?>? meta = null) { }
        public void Append(ChatMessage message) { }
        public List<SessionSummary> ListRecent(int n) => [];
        public List<ChatMessage> Load(string file) => [];
    }

    private sealed class FakeWriteTool : ToolPlugin
    {
        public override string Name => "write";
        public override string Description => "";
        public override JsonObject? Parameters => new() { ["type"] = "object", ["properties"] = new JsonObject() };
        public override bool NeedsPermission => true;
        public override string Preview(JsonObject args) => "";
        public override Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken) =>
            Task.FromResult("已写入");
    }

    private sealed class FakeReadTool : ToolPlugin
    {
        public override string Name => "read";
        public override string Description => "";
        public override JsonObject? Parameters => new() { ["type"] = "object", ["properties"] = new JsonObject() };
        public override bool NeedsPermission => false;
        public override string Preview(JsonObject args) => "";
        public override Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken) =>
            Task.FromResult("文件内容");
    }

    /// <summary>两段式假客户端：第一轮要 write、第二轮要 read，第三轮出最终回答。</summary>
    private sealed class WriteThenReadClient : IChatClient
    {
        private int _n;

        public Task<CompletionResult> ChatAsync(List<ChatMessage> messages, ChatOptions? options = null)
        {
            _n++;
            if (_n <= 2)
            {
                return Task.FromResult(new CompletionResult(new ChatMessage
                {
                    Role = "assistant",
                    Content = null,
                    ToolCalls = [new ToolCall($"c{_n}", _n == 1 ? "write" : "read", "{}")],
                }));
            }
            options?.OnText?.Invoke("。");
            return Task.FromResult(new CompletionResult(
                new ChatMessage { Role = "assistant", Content = "完成" }));
        }
    }

    private sealed class FakeProviderPlugin(IChatClient client) : ProviderPlugin
    {
        public override string Name => "fake";
        public override bool Matches(string baseUrl) => true;
        public override IChatClient Create(Config config) => client;
    }

    private static App FakeApp(bool planOn)
    {
        var provider = new WriteThenReadClient();
        var registry = new Registry()
            .Register(new FakeWriteTool())
            .Register(new FakeReadTool())
            .Register(new FakeProviderPlugin(provider));
        var app = new App(
            new Config { ApiKey = "k", BaseUrl = "http://127.0.0.1", Model = "fake", ContextLimit = 1_000_000 },
            registry,
            yolo: true,
            () => [ChatMessage.System("系统提示")],
            new FakeStore());
        app.PlanMode.Value = planOn;
        return app;
    }

    public static void All()
    {
        Runner.Case("Plan Mode 开启：写类工具被拒并引导产出计划，读类工具正常", () =>
        {
            var app = FakeApp(planOn: true);
            var events = new List<AgentEvent>();
            Turn.RunUserTurnAsync(app, "做个计划", new TurnHooks { Emit = events.Add },
                CancellationToken.None).GetAwaiter().GetResult();

            var results = events.OfType<AgentEvent.ToolResult>().ToList();
            Check.True(results.Count >= 2, $"应有两次工具回合，实际 {results.Count}");
            var writeDenied = results.FirstOrDefault(r => r.Name == "write");
            Check.True(writeDenied is not null && writeDenied.Summary.Contains("Plan Mode"),
                "write 应被 Plan Mode 拒绝");
            var readOk = results.FirstOrDefault(r => r.Name == "read");
            Check.True(readOk is not null && readOk.Summary.Contains("文件内容"), "read 不受影响");
            // 拒绝路径不发 tool_call 渲染事件：write 只有 tool_result，没有配对的 tool_call
            Check.True(!events.OfType<AgentEvent.ToolCall>().Any(c => c.Name == "write"),
                "write 不应发出 tool_call 事件");
        });

        Runner.Case("Plan Mode 关闭：写类工具正常执行", () =>
        {
            var app = FakeApp(planOn: false);
            var events = new List<AgentEvent>();
            Turn.RunUserTurnAsync(app, "直接写", new TurnHooks { Emit = events.Add },
                CancellationToken.None).GetAwaiter().GetResult();

            var writeResult = events.OfType<AgentEvent.ToolResult>().FirstOrDefault(r => r.Name == "write");
            Check.True(writeResult is not null && writeResult.Summary.Contains("已写入"),
                "Plan Mode 关闭时 write 应正常执行");
        });
    }
}
