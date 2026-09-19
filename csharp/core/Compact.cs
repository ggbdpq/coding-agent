using ccode.kernel;

namespace ccode.core;

/// <summary>compact 调用选项：取消令牌贯穿到摘要的 HTTP 请求（与三态 Ctrl+C 贯通）。</summary>
public sealed class CompactOptions
{
    public CancellationToken CancellationToken { get; init; }
}

/// <summary>
/// 上下文压缩（对齐 tcode/src/core/compact.ts，v0.4 打磨）：调当前模型把旧对话压成摘要，
/// 历史替换为 [system, 摘要消息, 最近 4 条原文]。trim（裁旧丢历史）降级为 compact 失败时的兜底。
/// 纪律：摘要失败/中止时原 messages 原封不动——compact 永不破坏会话（先算后改，成功才替换）。
/// </summary>
public static class Compact
{
    /// <summary>system + 至少 4 条对话才值得压缩。</summary>
    public const int MinMessages = 5;

    /// <summary>摘要之外保留最近多少条原文（任务细节不丢）。</summary>
    public const int TailKeep = 4;

    private const string SummaryPrompt =
        "请把下面的对话历史压缩成一份简洁的任务摘要，供后续工作参考。" +
        "必须保留：当前任务目标、已完成的关键步骤、重要文件路径与结论、尚未完成的事项。" +
        "直接输出摘要正文，不要客套。";

    /// <summary>
    /// 把 app.Messages 压缩成 [system, 摘要, 最近 TailKeep 条原文]；
    /// 返回压缩前后估算 token 之差（&gt;0 即省下的预算）。失败/取消抛异常，历史保持原样。
    /// </summary>
    public static async Task<int> CompactContextAsync(App app, CompactOptions? opts = null)
    {
        var cancellationToken = opts?.CancellationToken ?? default;
        var messages = app.Messages;
        if (messages.Count <= MinMessages)
            throw new InvalidOperationException("对话太短，没什么可压缩的");
        var before = Trim.EstimateTokens(messages);

        // transcript = messages[1:] 的 "role: content" 拼接（system 之后的全要）
        var transcript = string.Join("\n", messages.Skip(1).Select(m => $"{m.Role}: {m.Content ?? $"(tool_calls: {m.ToolCalls?.Count ?? 0} 个)"}"));
        var result = await app.Provider.ChatAsync(
        [
            ChatMessage.System("你是会话摘要器：只输出摘要正文，用简体中文，尽量精炼。"),
            ChatMessage.User($"{SummaryPrompt}\n\n--- 对话历史 ---\n{transcript}"),
        ], new ChatOptions { CancellationToken = cancellationToken });
        var summary = result.Message.Content;
        if (string.IsNullOrEmpty(summary))
            throw new InvalidOperationException("模型返回了空摘要");

        // 成功才动历史：system + 摘要 + 最近 TailKeep 条原文（切片点配对安全）
        var tailStart = PickTailStart(messages, Math.Max(1, messages.Count - TailKeep));
        var summaryMessage = ChatMessage.User(
            $"[此前对话的摘要——当前任务以此为背景继续]\n{summary}\n[摘要结束]");
        messages.RemoveRange(1, tailStart - 1);
        messages.Insert(1, summaryMessage);
        return Math.Max(0, before - Trim.EstimateTokens(messages));
    }

    /// <summary>尾部起点必须从 user 消息开始（配对安全：切片不打断 assistant/tool_call 与 tool 回应的配对）。</summary>
    internal static int PickTailStart(List<ChatMessage> messages, int idealStart)
    {
        for (var i = Math.Max(1, idealStart); i < messages.Count; i++)
            if (messages[i].Role == "user") return i;
        return messages.Count; // 找不到 user 边界 → 不保留尾巴
    }
}
