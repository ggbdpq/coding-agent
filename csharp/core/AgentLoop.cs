using System.Diagnostics;
using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.core;

public sealed class TurnDeps
{
    public required IChatClient Provider { get; init; }
    public required IReadOnlyList<ToolPlugin> Tools { get; init; }

    /// <summary>白名单免确认（SkipPermission）所需的运行环境（config.AllowWriteDirs）。</summary>
    public App? App { get; init; }

    /// <summary>权限闸门（NeedsPermission 的工具会被询问）；缺省视为全部放行。</summary>
    public Func<string, string, Task<bool>>? Check { get; init; }

    public Action<string>? OnText { get; init; }

    /// <summary>即将执行一次工具调用（callId, name, args）。</summary>
    public Action<string, string, JsonObject>? OnToolCall { get; init; }

    /// <summary>工具执行完毕（callId, name, result 全文, ms）。</summary>
    public Action<string, string, string, long>? OnToolResult { get; init; }

    /// <summary>每轮 token 用量（R5：promptTokens, completionTokens）。</summary>
    public Action<int, int>? OnUsage { get; init; }
}

/// <summary>
/// 核心循环：一轮对话 = 往传入的 messages 列表推进，直到模型不再要工具。
/// 不持有全局状态，方便测试与将来换壳（REPL/TUI/单发）。
/// 注意：按分层规则 loop 不插件化（Q4 决策）——它是这个项目的灵魂考点，
/// 保持普通静态类，接口化可替换但不进注册表。
/// </summary>
public static class AgentLoop
{
    /// <summary>防失控：单轮对话最多允许的工具往返次数。</summary>
    public const int MaxToolRounds = 40;

    public static async Task RunTurnAsync(List<ChatMessage> messages, TurnDeps deps,
        CancellationToken cancellationToken)
    {
        var schemas = Registry.ToSchemas(deps.Tools);

        for (var round = 0; round < MaxToolRounds; round++)
        {
            var options = new ChatOptions
            {
                Tools = schemas,
                CancellationToken = cancellationToken,
                OnText = deps.OnText,
                OnUsage = deps.OnUsage,
            };
            // 用户 Ctrl+C 时取消令牌贯穿到 HTTP 流读循环，这里抛出 OperationCanceledException
            var result = await deps.Provider.ChatAsync(messages, options);
            messages.Add(result.Message);
            if (result.Message.ToolCalls is not { Count: > 0 }) return;

            foreach (var call in result.Message.ToolCalls)
            {
                var args = ParseArgs(call.Arguments);
                var tool = deps.Tools.FirstOrDefault(t => t.Name == call.Name);
                if (tool is null)
                {
                    messages.Add(ChatMessage.Tool(call.Id,
                        $"错误：未知工具 {call.Name}。可用工具：{string.Join(", ", deps.Tools.Select(t => t.Name))}"));
                    continue;
                }
                // Plan Mode（只读规划）：写类工具拒绝执行，引导模型产出计划。
                // 在白名单与权限询问之前判定：不执行、不询问、也不发 tool_call 渲染事件
                if (deps.App?.PlanMode.Value == true && tool.NeedsPermission)
                {
                    const string denyText =
                        "当前处于 Plan Mode（只读规划）：禁止执行写类操作。请继续只读探索，并输出一份分步计划；完成后告知用户用 /plan 切回普通模式执行。";
                    messages.Add(ChatMessage.Tool(call.Id, denyText));
                    deps.OnToolResult?.Invoke(call.Id, tool.Name, denyText, 0);
                    continue;
                }
                deps.OnToolCall?.Invoke(call.Id, tool.Name, args);

                // 白名单优先（R4：SkipPermission 声明受信）→ 闸门逐次确认
                var allowed = true;
                if (tool.NeedsPermission && deps.Check != null)
                {
                    var whitelisted = deps.App != null && tool.SkipPermission(args, deps.App);
                    if (!whitelisted) allowed = await deps.Check(tool.Name, tool.Preview(args));
                }
                if (!allowed)
                {
                    messages.Add(ChatMessage.Tool(call.Id,
                        "用户拒绝了本次操作。请询问用户怎么办，或换一种方式；不要未经允许重试同样的操作。"));
                    deps.OnToolResult?.Invoke(call.Id, tool.Name, "（用户已拒绝）", 0);
                    continue;
                }

                var clock = Stopwatch.StartNew();
                string outcome;
                try
                {
                    outcome = await tool.RunAsync(args, cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    throw; // 用户取消：绝不吞成工具错误文本，让断尾修复接手
                }
                catch (Exception e)
                {
                    outcome = $"错误：{e.Message}";
                }
                clock.Stop();
                messages.Add(ChatMessage.Tool(call.Id, outcome));
                deps.OnToolResult?.Invoke(call.Id, tool.Name, outcome, clock.ElapsedMilliseconds);
            }
        }

        // 轮次熔断：不带工具再要一次总结，防止无限打转
        var final = await deps.Provider.ChatAsync(messages,
            new ChatOptions
            {
                CancellationToken = cancellationToken,
                OnText = deps.OnText,
                OnUsage = deps.OnUsage,
            });
        messages.Add(final.Message);
    }

    internal static JsonObject ParseArgs(string raw)
    {
        try
        {
            if (JsonNode.Parse(string.IsNullOrWhiteSpace(raw) ? "{}" : raw) is JsonObject obj) return obj;
        }
        catch
        {
            // 参数不是合法 JSON：不在这里报错，落下去让工具名的"错误"文本纠正模型
        }
        return new JsonObject();
    }
}
