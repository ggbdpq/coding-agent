using ccode.kernel;

namespace ccode.core;

/// <summary>
/// 上下文预算：粗估 token（不引分词器依赖），超限时从最旧的工具输出裁起。
/// 只动 tool 消息的 content，消息结构不动——assistant/tool_calls 与 tool 回应的
/// 配对关系保持完整，后续请求对 API 依然合法。
/// </summary>
public static class Trim
{
    /// <summary>保留最近多少条工具消息不动。</summary>
    public const int KeepRecentTools = 12;

    /// <summary>裁剪占位文本（模型能看懂发生了什么）。</summary>
    public const string Placeholder = "[早期工具输出已省略以释放上下文]";

    /// <summary>粗估 token：按 3 字符 ≈ 1 token 折中（英文约 4 字符/词、中文更密），另计每条固定开销。</summary>
    public static int EstimateTokens(IReadOnlyList<ChatMessage> messages)
    {
        long chars = 0;
        foreach (var message in messages)
        {
            chars += (message.Content?.Length ?? 0) + 8;
            foreach (var call in message.ToolCalls ?? [])
                chars += call.Name.Length + call.Arguments.Length + 8;
        }
        return (int)Math.Ceiling(chars / 3.0);
    }

    /// <summary>就地裁剪，返回被裁的消息条数；保留最近 KeepRecentTools 条工具输出，裁完仍超限就到顶。</summary>
    public static int TrimContext(List<ChatMessage> messages, int limit)
    {
        if (EstimateTokens(messages) <= limit) return 0;
        var toolIndices = new List<int>();
        for (var i = 0; i < messages.Count; i++)
            if (messages[i].Role == "tool") toolIndices.Add(i);
        var candidateCount = Math.Max(0, toolIndices.Count - KeepRecentTools);
        var trimmedCount = 0;
        for (var k = 0; k < candidateCount; k++)
        {
            if (EstimateTokens(messages) <= limit) break;
            var message = messages[toolIndices[k]];
            if (!string.IsNullOrEmpty(message.Content) && message.Content != Placeholder)
            {
                message.Content = Placeholder;
                trimmedCount++;
            }
        }
        return trimmedCount;
    }
}
