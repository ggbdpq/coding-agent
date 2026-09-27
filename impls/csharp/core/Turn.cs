using ccode.kernel;

namespace ccode.core;

/// <summary>一轮用户输入的钩子：权限闸门 + 规范事件出口。</summary>
public sealed class TurnHooks
{
    /// <summary>权限闸门（NeedsPermission 的工具会被询问）；缺省视为全部放行。</summary>
    public Func<string, string, Task<bool>>? Check { get; init; }

    /// <summary>规范事件出口（kernel/Types.cs 的 AgentEvent）：壳渲染、审计与测试断言都消费它。</summary>
    public Action<AgentEvent>? Emit { get; init; }
}

/// <summary>
/// 一轮用户输入的完整编排：轮前治理（超限先压缩、失败退裁剪）→ 入列 → 工具循环 →
/// 断尾修复 → 会话落盘。turn 是唯一的事件生产者，壳只订阅不拼装。
/// REPL 与未来的其他壳共用这里，保证裁剪/落盘/修复语义全项目只有一份。
/// </summary>
public static class Turn
{
    public static async Task RunUserTurnAsync(App app, string line, TurnHooks? hooks,
        CancellationToken cancellationToken)
    {
        hooks ??= new TurnHooks();
        var emit = hooks.Emit ?? (_ => { });

        // 轮前上下文治理（双档）：估算超预算 80% 先试摘要压缩（保留任务目标与最近原文），
        // 仍超限再退裁剪（丢最旧工具输出兜底）
        if (Trim.EstimateTokens(app.Messages) > app.Config.ContextLimit * 0.8)
        {
            try
            {
                var savedTokens = await Compact.CompactContextAsync(app,
                    new CompactOptions { CancellationToken = cancellationToken });
                emit(new AgentEvent.Compact(savedTokens));
            }
            catch
            {
                var trimmed = Trim.TrimContext(app.Messages, app.Config.ContextLimit);
                if (trimmed > 0) emit(new AgentEvent.Trimmed(trimmed));
            }
        }

        emit(new AgentEvent.TurnStart(Guid.NewGuid().ToString()));
        emit(new AgentEvent.User(line));

        app.Messages.Add(ChatMessage.User(line));
        var mark = app.Messages.Count - 1;
        try
        {
            await AgentLoop.RunTurnAsync(app.Messages, new TurnDeps
            {
                Provider = app.Provider,
                Tools = app.Registry.Tools(),
                App = app,
                Check = hooks.Check,
                OnText = delta => emit(new AgentEvent.TextDelta(delta)),
                OnToolCall = (callId, name, args) => emit(new AgentEvent.ToolCall(callId, name, args)),
                OnToolResult = (callId, name, result, ms) =>
                    emit(new AgentEvent.ToolResult(callId, name, result.Split('\n')[0], ms)),
                OnUsage = (promptTokens, completionTokens) =>
                    emit(new AgentEvent.Usage(promptTokens, completionTokens)),
            }, cancellationToken);
        }
        catch (Exception e)
        {
            // 中断可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法
            RepairTail(app);
            AppendSince(app, mark);
            emit(e is OperationCanceledException
                ? new AgentEvent.TurnEnd(TurnEndReason.Aborted)
                : new AgentEvent.TurnEnd(TurnEndReason.Error, e.Message));
            throw; // 展示方式是壳的事：REPL 区分中止/出错
        }
        AppendSince(app, mark);
        emit(new AgentEvent.TurnEnd(TurnEndReason.Completed));
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
