using System.Text.Json.Nodes;
using ccode.core;
using ccode.kernel;

namespace ccode.tests;

/// <summary>
/// 事件模型单测：turn 的规范事件序列（AgentEvent）是壳/审计/回放的公共契约。
/// 镜像 tcode/test/events.test.ts，锁死三件事：事件类型与顺序、turn_end 终态原因、
/// 断尾修复与事件的互不干扰。
/// </summary>
internal static class EventTests
{
    /// <summary>假会话存储：只记录 Append 调用。</summary>
    private sealed class FakeStore : ISessionStore
    {
        public List<ChatMessage> Appended { get; } = [];
        public List<ChatMessage> Initial { get; set; } = [];

        public void Start(IReadOnlyDictionary<string, object?>? meta = null) { }
        public void Append(ChatMessage message) => Appended.Add(message);
        public List<SessionSummary> ListRecent(int n) => [];
        public List<ChatMessage> Load(string file) => [.. Initial];
    }

    /// <summary>要工具→拿到结果→出最终回答 的两段式假客户端。</summary>
    private sealed class ToolThenTextClient : IChatClient
    {
        public Task<CompletionResult> ChatAsync(List<ChatMessage> messages, ChatOptions? options = null)
        {
            if (messages.All(m => m.Role != "tool"))
            {
                return Task.FromResult(new CompletionResult(new ChatMessage
                {
                    Role = "assistant",
                    Content = null,
                    ToolCalls = [new ToolCall("c1", "fake", "{}")],
                }));
            }
            options?.OnText?.Invoke("完成");
            return Task.FromResult(new CompletionResult(
                new ChatMessage { Role = "assistant", Content = "完成" }));
        }
    }

    /// <summary>两段式客户端：第二轮改抛异常（可指定异常类型），测终态原因。</summary>
    private sealed class ToolThenThrowClient(Func<ChatOptions?, Exception> makeError) : IChatClient
    {
        public Task<CompletionResult> ChatAsync(List<ChatMessage> messages, ChatOptions? options = null)
        {
            if (messages.All(m => m.Role != "tool"))
            {
                return Task.FromResult(new CompletionResult(new ChatMessage
                {
                    Role = "assistant",
                    ToolCalls = [new ToolCall("c1", "fake", "{}")],
                }));
            }
            throw makeError(options);
        }
    }

    /// <summary>首轮给工具调用（工具照常执行），次轮抛取消——测断尾修复与事件互不干扰。</summary>
    private sealed class ToolThenCancelClient : IChatClient
    {
        private bool _first = true;

        public Task<CompletionResult> ChatAsync(List<ChatMessage> messages, ChatOptions? options = null)
        {
            if (_first)
            {
                _first = false;
                return Task.FromResult(new CompletionResult(new ChatMessage
                {
                    Role = "assistant",
                    ToolCalls = [new ToolCall("c1", "fake", "{}")],
                }));
            }
            throw new OperationCanceledException(options?.CancellationToken ?? default);
        }
    }

    private sealed class FakeTool : ToolPlugin
    {
        public override string Name => "fake";
        public override string Description => "";
        public override JsonObject? Parameters => new() { ["type"] = "object", ["properties"] = new JsonObject() };
        public override bool NeedsPermission => false;
        public override string Preview(JsonObject args) => "";
        public override Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken) =>
            Task.FromResult("工具结果");
    }

    private sealed class FakeProviderPlugin(IChatClient client) : ProviderPlugin
    {
        public override string Name => "fake";
        public override bool Matches(string baseUrl) => true;
        public override IChatClient Create(Config config) => client;
    }

    private static App FakeApp(IChatClient provider, FakeStore? store = null)
    {
        store ??= new FakeStore();
        var registry = new Registry()
            .Register(new FakeTool())
            .Register(new FakeProviderPlugin(provider));
        return new App(
            new Config { ApiKey = "k", BaseUrl = "http://127.0.0.1", Model = "fake", ContextLimit = 1_000_000 },
            registry,
            yolo: true,
            () => [ChatMessage.System("系统提示")],
            store);
    }

    private static List<string> Types(List<AgentEvent> events) =>
        events.Select(e => e.GetType().Name).ToList();

    public static void All()
    {
        Runner.Case("事件：规范序列 TurnStart→User→ToolCall→ToolResult→TextDelta→TurnEnd(Completed)", () =>
        {
            var store = new FakeStore();
            var app = FakeApp(new ToolThenTextClient(), store);
            var events = new List<AgentEvent>();
            Turn.RunUserTurnAsync(app, "做事", new TurnHooks { Emit = events.Add },
                CancellationToken.None).GetAwaiter().GetResult();

            Check.Eq("TurnStart,User,ToolCall,ToolResult,TextDelta,TurnEnd",
                string.Join(",", Types(events)), "事件类型与顺序");
            var start = (AgentEvent.TurnStart)events[0];
            Check.True(Guid.TryParse(start.Id, out _), "TurnStart.Id 应是合法 GUID");
            var call = (AgentEvent.ToolCall)events[2];
            Check.Eq("c1", call.CallId, "ToolCall.CallId");
            Check.Eq("fake", call.Name, "ToolCall.Name");
            var result = (AgentEvent.ToolResult)events[3];
            Check.Eq("工具结果", result.Summary, "ToolResult.Summary 取第一行");
            var end = (AgentEvent.TurnEnd)events[^1];
            Check.Eq(TurnEndReason.Completed, end.Reason, "终态原因");
            Check.True(end.Error is null, "Completed 不带错误消息");
            // 会话落盘与事件不冲突：user + assistant + tool + assistant 四条
            Check.Eq(4, store.Appended.Count, "落盘条数");
        });

        Runner.Case("事件：取消（预取消令牌）→ TurnEnd(Aborted) 且异常为 OperationCanceledException", () =>
        {
            var app = FakeApp(new ToolThenThrowClient(_ => new OperationCanceledException("已取消")));
            var events = new List<AgentEvent>();
            Exception? caught = null;
            try
            {
                Turn.RunUserTurnAsync(app, "做事", new TurnHooks { Emit = events.Add },
                    new CancellationToken(canceled: true)).GetAwaiter().GetResult();
            }
            catch (Exception e) { caught = e; }

            Check.True(caught is OperationCanceledException, $"应上抛 OperationCanceledException，实际 {caught?.GetType().Name}");
            var end = events.Count > 0 ? events[^1] as AgentEvent.TurnEnd : null;
            Check.True(end is not null, "末事件应是 TurnEnd");
            Check.Eq(TurnEndReason.Aborted, end!.Reason, "终态原因");
        });

        Runner.Case("事件：一般错误 → TurnEnd(Error) 携带消息", () =>
        {
            var app = FakeApp(new ToolThenThrowClient(_ => new InvalidOperationException("网络炸了")));
            var events = new List<AgentEvent>();
            Exception? caught = null;
            try
            {
                Turn.RunUserTurnAsync(app, "做事", new TurnHooks { Emit = events.Add },
                    CancellationToken.None).GetAwaiter().GetResult();
            }
            catch (Exception e) { caught = e; }

            Check.True(caught is not null && caught.Message.Contains("网络炸了"), "异常应上抛且带消息");
            var end = events.Count > 0 ? events[^1] as AgentEvent.TurnEnd : null;
            Check.True(end is not null, "末事件应是 TurnEnd");
            Check.Eq(TurnEndReason.Error, end!.Reason, "终态原因");
            Check.Eq("网络炸了", end.Error, "错误消息");
        });

        Runner.Case("事件：断尾修复与事件互不干扰——工具已执行后中止，tool 结果仍在落盘序列", () =>
        {
            var store = new FakeStore();
            var app = FakeApp(new ToolThenCancelClient(), store);
            var events = new List<AgentEvent>();
            Exception? caught = null;
            try
            {
                Turn.RunUserTurnAsync(app, "做事", new TurnHooks { Emit = events.Add },
                    new CancellationToken(canceled: true)).GetAwaiter().GetResult();
            }
            catch (Exception e) { caught = e; }

            Check.True(caught is OperationCanceledException, "应上抛 OperationCanceledException");
            var roles = app.Messages.Select(m => m.Role).ToList();
            // system → user → assistant(tool_call) → tool → 无悬空调用
            Check.Eq("system,user,assistant,tool", string.Join(",", roles), "断尾修复后无悬空调用");
            Check.True(store.Appended.Count >= 3, "断尾修复后的消息也应落盘");
        });
    }
}
