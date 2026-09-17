using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.core;

public sealed class TurnHooks
{
    /// <summary>权限闸门（NeedsPermission 的工具会被询问）；缺省视为全部放行。</summary>
    public Func<string, string, Task<bool>>? Check { get; init; }

    public Action<string>? OnText { get; init; }
    public Action<string, JsonObject>? OnToolCall { get; init; }
    public Action<string, string, long>? OnToolResult { get; init; }

    /// <summary>上下文被裁剪时通知壳（REPL 打灰字）。</summary>
    public Action<int>? OnTrimmed { get; init; }
}

/// <summary>
/// 一轮用户输入的完整编排：裁剪 → 入列 → 工具循环 → 断尾修复 → 会话落盘。
/// REPL 与未来的其他壳共用这里，保证裁剪/落盘/修复语义全项目只有一份。
/// </summary>
public static class Turn
{
    public static async Task RunUserTurnAsync(App app, string line, TurnHooks? hooks,
        CancellationToken cancellationToken)
    {
        hooks ??= new TurnHooks();

        // 轮前裁剪：只影响发给模型的上下文；会话文件里保留完整历史
        var trimmed = Trim.TrimContext(app.Messages, app.Config.ContextLimit);
        if (trimmed > 0) hooks.OnTrimmed?.Invoke(trimmed);

        app.Messages.Add(ChatMessage.User(line));
        var mark = app.Messages.Count - 1;
        try
        {
            await AgentLoop.RunTurnAsync(app.Messages, new TurnDeps
            {
                Provider = app.Provider,
                Tools = app.Registry.Tools(),
                Check = hooks.Check,
                OnText = hooks.OnText,
                OnToolCall = hooks.OnToolCall,
                OnToolResult = hooks.OnToolResult,
            }, cancellationToken);
        }
        catch
        {
            // 中断（Ctrl+C）可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法
            RepairTail(app);
            AppendSince(app, mark);
            throw; // 展示方式是壳的事：REPL 区分中止/出错
        }
        AppendSince(app, mark);
    }

    /// <summary>中断可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法。</summary>
    internal static void RepairTail(App app)
    {
        var last = app.Messages[^1];
        if (last.Role != "assistant" || last.ToolCalls is not { Count: > 0 }) return;
        var answered = app.Messages
            .Where(m => m.Role == "tool" && m.ToolCallId != null)
            .Select(m => m.ToolCallId!)
            .ToHashSet();
        foreach (var call in last.ToolCalls)
            if (!answered.Contains(call.Id))
                app.Messages.Add(ChatMessage.Tool(call.Id, "（用户中止，未执行）"));
    }

    private static void AppendSince(App app, int mark)
    {
        for (var i = mark; i < app.Messages.Count; i++) app.Store.Append(app.Messages[i]);
    }
}
