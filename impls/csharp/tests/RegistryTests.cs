using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.tests;

/// <summary>TDD 切片4：Registry（注册/按类取用/重名拒绝/ToSchemas 形状）。</summary>
internal static class RegistryTests
{
    private sealed class FakeTool(string name) : ToolPlugin
    {
        public override string Name => name;
        public override string Description => $"desc-{name}";
        public override JsonObject? Parameters => new() { ["type"] = "object", ["properties"] = new JsonObject() };
        public override bool NeedsPermission => false;
        public override string Preview(JsonObject args) => "";
        public override Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken) =>
            Task.FromResult("");
    }

    private sealed class FakeCommand(string name) : CommandPlugin
    {
        public override string Name => name;
        public override string Usage => $"/{name}";
        public override string Summary => "s";
        public override Task<CommandOutcome> RunAsync(App app, string[] args) =>
            Task.FromResult(CommandOutcome.None);
    }

    private sealed class FakeProvider(string name) : ProviderPlugin
    {
        public override string Name => name;
        public override bool Matches(string baseUrl) => baseUrl.Contains(name);
        public override IChatClient Create(Config config) => throw new NotImplementedException();
    }

    private sealed class FakeShell(string name) : ShellPlugin
    {
        public override string Name => name;
        public override Task StartAsync(App app) => Task.CompletedTask;
    }

    public static void All()
    {
        Runner.Case("registry：按类取用且保持注册顺序", () =>
        {
            var registry = new Registry()
                .Register(new FakeTool("t1"))
                .Register(new FakeCommand("c1"))
                .Register(new FakeTool("t2"))
                .Register(new FakeProvider("p1"))
                .Register(new FakeShell("repl"));
            Check.Eq("t1,t2", string.Join(",", registry.Tools().Select(t => t.Name)), "tools 顺序");
            Check.Eq("c1", string.Join(",", registry.Commands().Select(c => c.Name)), "commands");
            Check.Eq("p1", string.Join(",", registry.Providers().Select(p => p.Name)), "providers");
            Check.Eq("repl", registry.Shell("repl")?.Name, "shell 按名");
            Check.True(registry.Shell("missing") is null, "找不到返回 null");
        });
        Runner.Case("registry：同 kind 重名拒绝，跨 kind 同名放行", () =>
        {
            var registry = new Registry().Register(new FakeTool("dup"));
            Check.Throws<Exception>(() => registry.Register(new FakeTool("dup")), "同 kind 重名应拒绝");
            registry.Register(new FakeCommand("dup")); // 不同 kind 同名允许
            registry.Register(new FakeProvider("dup"));
            Check.Eq(3, registry.Tools().Count + registry.Commands().Count + registry.Providers().Count,
                "三类各存一份");
        });
        Runner.Case("registry：重名错误信息含 kind/name", () =>
        {
            var registry = new Registry().Register(new FakeTool("dup"));
            try
            {
                registry.Register(new FakeTool("dup"));
            }
            catch (Exception e)
            {
                Check.Contains("插件重名", e.Message, "错误信息");
                Check.Contains("tool/dup", e.Message, "kind/name");
                return;
            }
            Check.True(false, "应抛出");
        });
        Runner.Case("registry：ToSchemas 形状", () =>
        {
            var schemas = Registry.ToSchemas([new FakeTool("read")]);
            Check.Eq(1, schemas.Count, "数量");
            Check.Eq("read", schemas[0].Name, "name");
            Check.Eq("desc-read", schemas[0].Description, "description");
            Check.True(schemas[0].Parameters is JsonObject parameters &&
                       JsonUtil.Str(parameters["type"]) == "object", "parameters 原样透传");
        });
        Runner.Case("registry：ToolSchemas 与 ToSchemas 等价", () =>
        {
            var registry = new Registry().Register(new FakeTool("a")).Register(new FakeTool("b"));
            Check.Eq(2, registry.ToolSchemas().Count, "数量");
            Check.Eq("a,b", string.Join(",", registry.ToolSchemas().Select(s => s.Name)), "顺序");
        });
    }
}
