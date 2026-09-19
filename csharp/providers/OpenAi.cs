using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.providers;

/// <summary>
/// OpenAI 兼容 /chat/completions 客户端 + 对应 provider 插件（兜底：Matches 恒真）。
/// 只支持流式——coding agent 的体感底线，也顺便让工具调用前的等待可见。
/// </summary>
public sealed class OpenAiClient(string baseUrl, string apiKey, string model) : IChatClient
{
    /// <summary>最多 3 次尝试；仅首字节前可重试（流已开始的中断不重试，避免内容重复）。</summary>
    public Task<CompletionResult> ChatAsync(List<ChatMessage> messages, ChatOptions? options = null) =>
        Retry.WithRetryAsync(() => AttemptAsync(messages, options ?? new()),
            options?.CancellationToken ?? default);

    private async Task<CompletionResult> AttemptAsync(List<ChatMessage> messages, ChatOptions options)
    {
        var cancellationToken = options.CancellationToken;
        var body = new JsonObject { ["model"] = model, ["stream"] = true };
        // R5：让兼容端点在流末尾回传 usage（usage-only 的收尾 chunk）
        body["stream_options"] = new JsonObject { ["include_usage"] = true };
        var messageNodes = new JsonArray();
        foreach (var message in messages) messageNodes.Add(ChatMessageJson.ToNode(message));
        body["messages"] = messageNodes;
        if (options.Tools is { Count: > 0 })
        {
            var toolNodes = new JsonArray();
            foreach (var tool in options.Tools)
            {
                toolNodes.Add(new JsonObject
                {
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = tool.Name,
                        ["description"] = tool.Description,
                        ["parameters"] = tool.Parameters?.DeepClone() ?? new JsonObject(),
                    },
                });
            }
            body["tools"] = toolNodes;
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/chat/completions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Content = new StringContent(body.ToJsonString(JsonUtil.WireOptions), Encoding.UTF8, "application/json");
        using var response = await SharedHttp.Client.SendAsync(
            request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync(cancellationToken);
            var brief = text.Length > 300 ? text[..300] + "…" : text;
            var status = (int)response.StatusCode;
            var message = $"HTTP {status}：{(brief.Length > 0 ? brief : response.ReasonPhrase ?? "")}";
            if (status == 429 || status >= 500) throw new RetryableException(message);
            throw new InvalidOperationException(message);
        }

        // 流式增量装配：正文直接累加；工具调用按 index 分槽拼装碎片
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var content = "";
        var calls = new Dictionary<int, (string Id, string Name, string Args)>();
        await foreach (var data in Sse.DataAsync(stream, cancellationToken))
        {
            if (data == "[DONE]") break;
            JsonNode? chunk;
            try { chunk = JsonNode.Parse(data); }
            catch { continue; /* 非 JSON 行（注释、心跳）直接跳过 */ }

            // R5：流末尾的 usage chunk（choices 为空）携带 token 用量
            if (chunk?["usage"] is JsonObject usage)
            {
                var promptTokens = JsonUtil.Int(usage["prompt_tokens"]);
                var completionTokens = JsonUtil.Int(usage["completion_tokens"]);
                if (promptTokens > 0 || completionTokens > 0)
                    options.OnUsage?.Invoke(promptTokens, completionTokens);
            }

            var delta = chunk?["choices"]?[0]?["delta"];
            if (delta is null) continue;

            var contentDelta = JsonUtil.Str(delta["content"]);
            if (!string.IsNullOrEmpty(contentDelta))
            {
                content += contentDelta;
                options.OnText?.Invoke(contentDelta);
            }
            if (delta["tool_calls"] is JsonArray toolDeltas)
            {
                foreach (var item in toolDeltas)
                {
                    if (item is not JsonObject td) continue;
                    var index = JsonUtil.Int(td["index"], 0);
                    var slot = calls.TryGetValue(index, out var existing)
                        ? existing
                        : (Id: "", Name: "", Args: "");
                    var id = JsonUtil.Str(td["id"]);
                    if (id != null) slot.Id = id;
                    var name = JsonUtil.Str((td["function"] as JsonObject)?["name"]);
                    if (name != null) slot.Name += name;
                    var fragment = JsonUtil.Str((td["function"] as JsonObject)?["arguments"]);
                    if (fragment != null) slot.Args += fragment;
                    calls[index] = slot;
                }
            }
        }

        var toolCalls = new List<ToolCall>();
        foreach (var (index, slot) in calls.OrderBy(kv => kv.Key))
        {
            toolCalls.Add(new ToolCall(
                slot.Id.Length > 0 ? slot.Id : $"call_{index}",
                slot.Name,
                slot.Args.Length > 0 ? slot.Args : "{}"));
        }

        return new CompletionResult(new ChatMessage
        {
            Role = "assistant",
            Content = content.Length > 0 ? content : null,
            ToolCalls = toolCalls.Count > 0 ? toolCalls : null,
        });
    }
}

/// <summary>openai provider 插件：兜底，注册顺序放清单最后。</summary>
public sealed class OpenAiPlugin : ProviderPlugin
{
    public override string Name => "openai";

    // 兜底：没被其他 provider 命中的 BASE_URL 都走 OpenAI 兼容
    public override bool Matches(string baseUrl) => true;

    public override IChatClient Create(Config config) =>
        new OpenAiClient(config.BaseUrl, config.ApiKey, config.Model);
}
