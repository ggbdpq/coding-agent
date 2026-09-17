using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.providers;

/// <summary>
/// Anthropic Messages 协议客户端（POST {baseUrl}/v1/messages）+ provider 插件：
/// 服务于 Claude 官方 API、DeepSeek /anthropic 端点及同类兼容中转。
/// 消息映射：system 提为顶层参数；tool 消息转为 user 角色的 tool_result 块；
/// 相邻同角色消息合并（Anthropic 要求 user/assistant 严格交替）。
/// </summary>
public sealed class AnthropicClient(string baseUrl, string apiKey, string model) : IChatClient
{
    public const string AnthropicVersion = "2023-06-01";
    public const int DefaultMaxTokens = 8192;

    /// <summary>与 OpenAI 版相同的重试纪律：最多 3 次，仅首字节前可重试，用户取消绝不重试。</summary>
    public Task<CompletionResult> ChatAsync(List<ChatMessage> messages, ChatOptions? options = null) =>
        Retry.WithRetryAsync(() => AttemptAsync(messages, options ?? new()),
            options?.CancellationToken ?? default);

    /// <summary>内部（OpenAI 形状）消息 → Anthropic 请求体。</summary>
    public static JsonObject BuildRequest(
        IReadOnlyList<ChatMessage> messages, string model, int maxTokens, IReadOnlyList<ToolSchema>? tools)
    {
        var system = new List<string>();
        var flat = new List<(string Role, List<JsonObject> Blocks)>();
        foreach (var message in messages)
        {
            if (message.Role == "system")
            {
                if (!string.IsNullOrEmpty(message.Content)) system.Add(message.Content);
                continue;
            }
            if (message.Role == "user")
            {
                flat.Add(("user", [new JsonObject { ["type"] = "text", ["text"] = message.Content ?? "" }]));
                continue;
            }
            if (message.Role == "tool")
            {
                flat.Add(("user", [new JsonObject
                {
                    ["type"] = "tool_result",
                    ["tool_use_id"] = message.ToolCallId ?? "",
                    ["content"] = message.Content ?? "",
                }]));
                continue;
            }
            var blocks = new List<JsonObject>();
            if (!string.IsNullOrEmpty(message.Content))
                blocks.Add(new JsonObject { ["type"] = "text", ["text"] = message.Content });
            foreach (var call in message.ToolCalls ?? [])
            {
                JsonNode input = new JsonObject();
                try
                {
                    if (JsonNode.Parse(string.IsNullOrWhiteSpace(call.Arguments) ? "{}" : call.Arguments)
                        is JsonNode parsed)
                        input = parsed;
                }
                catch
                {
                    /* 非法参数保持 {}，让对端/工具层报错 */
                }
                blocks.Add(new JsonObject
                {
                    ["type"] = "tool_use",
                    ["id"] = call.Id,
                    ["name"] = call.Name,
                    ["input"] = input,
                });
            }
            flat.Add(("assistant", blocks));
        }

        // 相邻同角色合并
        var merged = new List<JsonObject>();
        foreach (var (role, blocks) in flat)
        {
            if (merged.Count > 0 && JsonUtil.Str(merged[^1]["role"]) == role)
            {
                foreach (var block in blocks) ((JsonArray)merged[^1]["content"]!).Add(block);
            }
            else
            {
                var content = new JsonArray();
                foreach (var block in blocks) content.Add(block);
                merged.Add(new JsonObject { ["role"] = role, ["content"] = content });
            }
        }

        var request = new JsonObject { ["model"] = model, ["max_tokens"] = maxTokens };
        if (system.Count > 0) request["system"] = string.Join("\n", system);
        var messageNodes = new JsonArray();
        foreach (var m in merged) messageNodes.Add(m);
        request["messages"] = messageNodes;
        if (tools is { Count: > 0 })
        {
            var toolNodes = new JsonArray();
            foreach (var tool in tools)
            {
                toolNodes.Add(new JsonObject
                {
                    ["name"] = tool.Name,
                    ["description"] = tool.Description,
                    ["input_schema"] = tool.Parameters?.DeepClone() ?? new JsonObject(),
                });
            }
            request["tools"] = toolNodes;
        }
        request["stream"] = true;
        return request;
    }

    private async Task<CompletionResult> AttemptAsync(List<ChatMessage> messages, ChatOptions options)
    {
        var cancellationToken = options.CancellationToken;
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/v1/messages");
        request.Headers.TryAddWithoutValidation("x-api-key", apiKey);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Headers.TryAddWithoutValidation("anthropic-version", AnthropicVersion);
        request.Content = new StringContent(
            BuildRequest(messages, model, DefaultMaxTokens, options.Tools).ToJsonString(JsonUtil.WireOptions),
            Encoding.UTF8, "application/json");
        using var response = await SharedHttp.Client.SendAsync(
            request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(cancellationToken);
            var brief = errorBody.Length > 300 ? errorBody[..300] + "…" : errorBody;
            var status = (int)response.StatusCode;
            var message = $"HTTP {status}：{(brief.Length > 0 ? brief : response.ReasonPhrase ?? "")}";
            if (status == 429 || status == 529 || status >= 500) throw new RetryableException(message);
            throw new InvalidOperationException(message);
        }

        // 事件装配：text_delta 累加正文；tool_use 块按 index 收 input_json_delta 碎片
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var text = "";
        var toolBlocks = new Dictionary<int, (string Id, string Name, string Json)>();
        await foreach (var data in Sse.DataAsync(stream, cancellationToken))
        {
            JsonNode? ev;
            try { ev = JsonNode.Parse(data); }
            catch { continue; }
            var type = JsonUtil.Str(ev?["type"]);
            if (type == "error")
                throw new InvalidOperationException($"流内错误：{JsonUtil.Str((ev?["error"] as JsonObject)?["message"]) ?? data}");
            if (type == "content_block_start" && JsonUtil.Str((ev?["content_block"] as JsonObject)?["type"]) == "tool_use")
            {
                var index = JsonUtil.Int(ev?["index"], 0);
                toolBlocks[index] = (
                    JsonUtil.Str((ev?["content_block"] as JsonObject)?["id"]) ?? "",
                    JsonUtil.Str((ev?["content_block"] as JsonObject)?["name"]) ?? "",
                    "");
                continue;
            }
            if (type == "content_block_delta")
            {
                var index = JsonUtil.Int(ev?["index"], 0);
                var delta = ev?["delta"] as JsonObject;
                var deltaType = JsonUtil.Str(delta?["type"]);
                if (deltaType == "text_delta")
                {
                    var fragment = JsonUtil.Str(delta?["text"]);
                    if (!string.IsNullOrEmpty(fragment))
                    {
                        text += fragment;
                        options.OnText?.Invoke(fragment);
                    }
                }
                else if (deltaType == "input_json_delta")
                {
                    var fragment = JsonUtil.Str(delta?["partial_json"]);
                    if (fragment != null && toolBlocks.TryGetValue(index, out var block))
                        toolBlocks[index] = block with { Json = block.Json + fragment };
                }
            }
            // message_delta / message_stop / ping：块拼完即返回，无需特殊处理
        }

        var toolCalls = new List<ToolCall>();
        foreach (var (index, block) in toolBlocks.OrderBy(kv => kv.Key))
        {
            toolCalls.Add(new ToolCall(
                block.Id.Length > 0 ? block.Id : $"toolu_{index}",
                block.Name,
                NormalizeArgs(block.Json)));
        }

        return new CompletionResult(new ChatMessage
        {
            Role = "assistant",
            Content = text.Length > 0 ? text : null,
            ToolCalls = toolCalls.Count > 0 ? toolCalls : null,
        });
    }

    /// <summary>解析一遍再序列化：既验证 JSON 完整性，也归一成内部 arguments 字符串；流被截断时保留原文。</summary>
    private static string NormalizeArgs(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "{}";
        try
        {
            return JsonNode.Parse(raw)?.ToJsonString(JsonUtil.WireOptions) ?? "{}";
        }
        catch (JsonException)
        {
            return raw; // 工具层的 JSON 解析会兜底报错
        }
    }
}

/// <summary>anthropic provider 插件：BASE_URL 含 /anthropic 时命中（注册在 openai 兜底之前）。</summary>
public sealed class AnthropicPlugin : ProviderPlugin
{
    public override string Name => "anthropic";

    public override bool Matches(string baseUrl) => baseUrl.Contains("/anthropic");

    public override IChatClient Create(Config config) =>
        new AnthropicClient(config.BaseUrl, config.ApiKey, config.Model);
}
