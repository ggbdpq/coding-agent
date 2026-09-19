using ccode.core;
using ccode.kernel;

namespace ccode.tests;

/// <summary>
/// compact 单测：摘要替换历史、失败/取消永不破坏会话（compact 永不动摇原历史）。
/// 镜像 tcode/test/compact.test.ts。
/// </summary>
internal static class CompactTests
{
    private sealed class FakeStore : ISessionStore
    {
        public void Start(IReadOnlyDictionary<string, object?>? meta = null) { }
        public void Append(ChatMessage message) { }
        public List<SessionSummary> ListRecent(int n) => [];
        public List<ChatMessage> Load(string file) => [];
    }

    private sealed class SummarizerClient : IChatClient
    {
        public Task<CompletionResult> ChatAsync(List<ChatMessage> messages, ChatOptions? options = null) =>
            Task.FromResult(new CompletionResult(
                new ChatMessage { Role = "assistant", Content = "这是摘要" }));
    }

    private sealed class ThrowingClient(Exception error) : IChatClient
    {
        public Task<CompletionResult> ChatAsync(List<ChatMessage> messages, ChatOptions? options = null) =>
            throw error;
    }

    private static App FakeApp(IChatClient provider, List<ChatMessage> messages)
    {
        var registry = new Registry().Register(new SummarizerProvider(provider));
        return new App(
            new Config { ApiKey = "k", BaseUrl = "http://127.0.0.1", Model = "fake", ContextLimit = 1_000_000 },
            registry,
            yolo: true,
            () => [.. messages],
            new FakeStore());
    }

    private sealed class SummarizerProvider(IChatClient client) : ProviderPlugin
    {
        public override string Name => "fake";
        public override bool Matches(string baseUrl) => true;
        public override IChatClient Create(Config config) => client;
    }

    /// <summary>system + 10 组问答 = 21 条，长度足够压缩。</summary>
    private static List<ChatMessage> HistoryMessages()
    {
        var messages = new List<ChatMessage> { ChatMessage.System("系统提示") };
        for (var i = 0; i < 10; i++)
        {
            messages.Add(ChatMessage.User($"问题 {i}"));
            messages.Add(new ChatMessage { Role = "assistant", Content = $"回答 {i}" });
        }
        return messages;
    }

    /// <summary>消息列表快照（序列化比对，DeepEqual 的替代）。</summary>
    private static List<string> Snapshot(List<ChatMessage> messages) =>
        messages.Select(m => ChatMessageJson.ToNode(m).ToJsonString()).ToList();

    public static void All()
    {
        Runner.Case("compact：摘要 + 保留最近 4 条原文，返回节省 token 数", () =>
        {
            var messages = HistoryMessages();
            var app = FakeApp(new SummarizerClient(), messages);
            var before = app.Messages.Count;

            var savedTokens = Compact.CompactContextAsync(app).GetAwaiter().GetResult();

            Check.True(savedTokens > 0, "savedTokens 应大于 0");
            Check.Eq(6, app.Messages.Count, "system + 摘要 + 最近 4 条原文");
            Check.Eq("system", app.Messages[0].Role, "首条仍是 system");
            Check.Eq("系统提示", app.Messages[0].Content, "system 内容不变");
            Check.Contains("这是摘要", app.Messages[1].Content ?? "", "摘要正文");
            Check.Eq("user", app.Messages[1].Role, "摘要消息是纯 user 文本");
            // 最近 4 条原文保留：tail 从 user 边界开始，内容与原末尾一致
            Check.Eq("user", app.Messages[2].Role, "尾部首条应是 user");
            Check.Eq(
                string.Join("|", messages.Skip(messages.Count - 4).Select(m => $"{m.Role}:{m.Content}")),
                string.Join("|", app.Messages.Skip(2).Select(m => $"{m.Role}:{m.Content}")),
                "尾部 4 条与原历史末尾逐条一致");
            Check.True(before > app.Messages.Count, "历史应变短");
        });

        Runner.Case("compact：配对安全切片——理想切点落在 tool 消息上时向前扫描到 user", () =>
        {
            // 构造理想切点（len-4）恰为 tool 消息的历史：
            // 0 system,1 user,2 assistant(tc),3 tool,4 user,5 assistant(tc),6 tool,7 user,8 assistant,9 user
            var messages = new List<ChatMessage>
            {
                ChatMessage.System("系统提示"),
                ChatMessage.User("u1"),
                new() { Role = "assistant", ToolCalls = [new ToolCall("c1", "bash", "{}")] },
                ChatMessage.Tool("c1", "r1"),
                ChatMessage.User("u2"),
                new() { Role = "assistant", ToolCalls = [new ToolCall("c2", "bash", "{}")] },
                ChatMessage.Tool("c2", "r2"),
                ChatMessage.User("u3"),
                new() { Role = "assistant", Content = "a3" },
                ChatMessage.User("u4"),
            };
            var app = FakeApp(new SummarizerClient(), messages);

            Compact.CompactContextAsync(app).GetAwaiter().GetResult();

            // tail 从 idx7（user）开始，len-4=6 的 tool 不作切点
            Check.Eq(5, app.Messages.Count, "system + 摘要 + 3 条尾部");
            Check.Eq("u3", app.Messages[2].Content, "尾部从 user 边界开始");
            Check.True(app.Messages.All(m => m.Role != "tool"), "摘要区已展平，无悬空 tool 消息");
        });

        Runner.Case("compact：历史太短（≤5 条）时拒绝并保持原状", () =>
        {
            var messages = new List<ChatMessage>
            {
                ChatMessage.System("s"),
                ChatMessage.User("a"),
                new ChatMessage { Role = "assistant", Content = "b" },
            };
            var app = FakeApp(new SummarizerClient(), messages);
            string? error = null;
            try { Compact.CompactContextAsync(app).GetAwaiter().GetResult(); }
            catch (Exception e) { error = e.Message; }

            Check.True(error is not null && error.Contains("没什么可压缩"), $"应拒绝并说明原因，实际：{error}");
            Check.Eq(3, app.Messages.Count, "原历史原封不动");
        });

        Runner.Case("compact：摘要失败（网络错）时原历史原封不动", () =>
        {
            var messages = HistoryMessages();
            var snapshot = Snapshot(messages);
            var app = FakeApp(new ThrowingClient(new InvalidOperationException("网络炸了")), messages);
            string? error = null;
            try { Compact.CompactContextAsync(app).GetAwaiter().GetResult(); }
            catch (Exception e) { error = e.Message; }

            Check.True(error is not null && error.Contains("网络炸了"), "异常应上抛");
            Check.Eq(string.Join("\n", snapshot), string.Join("\n", Snapshot(app.Messages)),
                "失败后历史逐条不变");
        });

        Runner.Case("compact：用户取消时原历史原封不动且异常为 OperationCanceledException", () =>
        {
            var messages = HistoryMessages();
            var app = FakeApp(
                new ThrowingClient(new OperationCanceledException(new CancellationToken(canceled: true))),
                messages);
            Exception? caught = null;
            try
            {
                Compact.CompactContextAsync(app, new CompactOptions
                {
                    CancellationToken = new CancellationToken(canceled: true),
                }).GetAwaiter().GetResult();
            }
            catch (Exception e) { caught = e; }

            Check.True(caught is OperationCanceledException, $"应上抛 OperationCanceledException，实际 {caught?.GetType().Name}");
            Check.Eq(21, app.Messages.Count, "取消后历史原封不动");
        });
    }
}
