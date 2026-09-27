// 共享词汇表：两种协议与核心逻辑共同依赖的线格式类型。
// 放 kernel 是因为 core/providers/session 都要引用，且不含任何行为。
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ccode.kernel;

/// <summary>一次工具调用。OpenAI wire 上是 function 形状，这里拍平成惯用字段。</summary>
public sealed record ToolCall(string Id, string Name, string Arguments);

/// <summary>直传 function calling 的工具 schema。</summary>
public sealed record ToolSchema(string Name, string Description, JsonNode? Parameters);

/// <summary>会话消息；裁剪会就地改 Content，会话层会序列化它。</summary>
public sealed class ChatMessage
{
    public string Role { get; set; } = "";
    public string? Content { get; set; }
    public List<ToolCall>? ToolCalls { get; set; }
    public string? ToolCallId { get; set; }

    public static ChatMessage System(string content) => new() { Role = "system", Content = content };
    public static ChatMessage User(string content) => new() { Role = "user", Content = content };
    public static ChatMessage Tool(string toolCallId, string content) =>
        new() { Role = "tool", ToolCallId = toolCallId, Content = content };
}

public sealed record CompletionResult(ChatMessage Message);

/// <summary>chat 请求选项：工具清单、取消令牌、正文增量回调（工具调用参数不走这里）、token 用量回调。</summary>
public sealed class ChatOptions
{
    public List<ToolSchema>? Tools { get; init; }
    public CancellationToken CancellationToken { get; init; }
    public Action<string>? OnText { get; init; }

    /// <summary>每轮 token 用量（R5：promptTokens, completionTokens；provider 从流内事件解析）。</summary>
    public Action<int, int>? OnUsage { get; init; }
}

/// <summary>两种协议客户端的共同形状：agentloop 只认这个。</summary>
public interface IChatClient
{
    Task<CompletionResult> ChatAsync(List<ChatMessage> messages, ChatOptions? options = null);
}

/// <summary>turn 终态原因：Completed=模型收尾；Aborted=用户中止；Error=异常。</summary>
public enum TurnEndReason
{
    Completed,
    Aborted,
    Error,
}

/// <summary>
/// 规范事件流（v1 事件模型）：turn 是唯一生产者，壳/审计/回放是消费者。
/// C# 没有 TS 的可辨识联合，用"抽象基类 + 嵌套 sealed record"表达同一契约：
/// 每个变体一个 record，switch 模式匹配逐变体消费（见 shell/Repl.cs）。
/// Permission/Usage 变体是占位契约（对应 tcode 的 R2/R5 预留），本版尚无生产者。
/// </summary>
public abstract record AgentEvent
{
    /// <summary>一轮开始（Id = 本轮唯一标识）。</summary>
    public sealed record TurnStart(string Id) : AgentEvent;

    /// <summary>用户输入已入列。</summary>
    public sealed record User(string Text) : AgentEvent;

    /// <summary>模型正文增量（工具调用参数不走这里）。</summary>
    public sealed record TextDelta(string Delta) : AgentEvent;

    /// <summary>即将执行一次工具调用。</summary>
    public sealed record ToolCall(string CallId, string Name, JsonObject Args) : AgentEvent;

    /// <summary>工具执行完毕（Summary 取结果首行，Ms 为耗时毫秒）。</summary>
    public sealed record ToolResult(string CallId, string Name, string Summary, long Ms) : AgentEvent;

    /// <summary>权限询问（占位：本版权限 UI 仍走 core/Permission 的闸门回调）。</summary>
    public sealed record Permission(string Id, string Tool, string Preview) : AgentEvent;

    /// <summary>轮前治理裁剪了 N 条早期工具输出。</summary>
    public sealed record Trimmed(int Count) : AgentEvent;

    /// <summary>轮前治理把历史压缩为任务摘要，省下约 N tokens。</summary>
    public sealed record Compact(int SavedTokens) : AgentEvent;

    /// <summary>每轮 token 用量（R5：provider 从流内 usage 事件解析，turn 层发出）。</summary>
    public sealed record Usage(int PromptTokens, int CompletionTokens) : AgentEvent;

    /// <summary>一轮结束；Error 仅在 Reason=Error 时携带异常消息。</summary>
    public sealed record TurnEnd(TurnEndReason Reason, string? Error = null) : AgentEvent;
}

/// <summary>会话级 yolo 开关（--yolo 或 /yolo / 权限确认里的 a 都改它）。</summary>
public sealed class YoloRef(bool value = false)
{
    public bool Value { get; set; } = value;
}

/// <summary>JSON 读取小助手：安全取标量值，缺失或 JSON null 返回缺省。</summary>
public static class JsonUtil
{
    /// <summary>
    /// 线格式写出选项：不转义非 ASCII 字符（与 tcode 的 JSON.stringify 同语义，
    /// 请求体与会话文件保持可读的中文原文）。
    /// </summary>
    public static readonly JsonSerializerOptions WireOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>安全取字符串：缺失或 JSON null 返回 null。</summary>
    public static string? Str(JsonNode? node)
    {
        if (node is null || node.GetValueKind() == JsonValueKind.Null) return null;
        try { return node.GetValue<string>(); }
        catch { return null; }
    }

    /// <summary>安全取整数：2.0 这类双精度也接受；缺失/非数值返回缺省。</summary>
    public static int Int(JsonNode? node, int fallback = 0)
    {
        if (node is null || node.GetValueKind() != JsonValueKind.Number) return fallback;
        try
        {
            if (node is JsonValue value && value.TryGetValue<int>(out var i)) return i;
            return (int)node.GetValue<double>();
        }
        catch { return fallback; }
    }

    /// <summary>安全取布尔；缺失/非布尔返回缺省。</summary>
    public static bool Bool(JsonNode? node, bool fallback = false)
    {
        if (node is null) return fallback;
        return node.GetValueKind() switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => fallback,
        };
    }
}

/// <summary>线格式 JSON 映射：消息 ↔ tcode 同构的 JSON 形状（会话文件与 OpenAI 请求共用）。</summary>
public static class ChatMessageJson
{
    public static JsonObject ToNode(ChatMessage message)
    {
        var node = new JsonObject { ["role"] = message.Role, ["content"] = message.Content };
        if (message.ToolCallId is not null) node["tool_call_id"] = message.ToolCallId;
        if (message.ToolCalls is { Count: > 0 })
        {
            var calls = new JsonArray();
            foreach (var call in message.ToolCalls)
            {
                calls.Add(new JsonObject
                {
                    ["id"] = call.Id,
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = call.Name,
                        ["arguments"] = call.Arguments,
                    },
                });
            }
            node["tool_calls"] = calls;
        }
        return node;
    }

    public static ChatMessage? FromNode(JsonObject node)
    {
        var role = JsonUtil.Str(node["role"]);
        if (role is null) return null;
        var message = new ChatMessage { Role = role, Content = JsonUtil.Str(node["content"]) };
        var toolCallId = JsonUtil.Str(node["tool_call_id"]);
        if (toolCallId is not null) message.ToolCallId = toolCallId;
        if (node["tool_calls"] is JsonArray calls)
        {
            message.ToolCalls = [];
            foreach (var item in calls)
            {
                if (item is not JsonObject call) continue;
                var function = call["function"] as JsonObject;
                message.ToolCalls.Add(new ToolCall(
                    JsonUtil.Str(call["id"]) ?? "",
                    JsonUtil.Str(function?["name"]) ?? "",
                    JsonUtil.Str(function?["arguments"]) ?? "{}"));
            }
        }
        return message;
    }
}
