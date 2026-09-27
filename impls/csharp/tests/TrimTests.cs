using ccode.core;
using ccode.kernel;

namespace ccode.tests;

/// <summary>TDD 切片2：Trim 估算与裁剪（裁旧留新 12、配对完整、幂等）。</summary>
internal static class TrimTests
{
    private static ChatMessage ToolWith(int chars) =>
        ChatMessage.Tool($"t{chars}", new string('x', chars));

    public static void All()
    {
        Runner.Case("trim：估算 = ceil(字符+固定开销 / 3)", () =>
        {
            var messages = new List<ChatMessage> { new ChatMessage { Role = "system", Content = new string('a', 30) } };
            // (30 + 8) / 3 = 12.67 → ceil 13
            Check.Eq(13, Trim.EstimateTokens(messages), "纯 system 消息");
        });
        Runner.Case("trim：tool_calls 的名字与参数计入估算", () =>
        {
            var message = new ChatMessage
            {
                Role = "assistant",
                ToolCalls = [new ToolCall("id", "bash", new string('p', 8))],
            };
            // 8(content 开销) + (2 + 4 + 8 + 8) = 30 → ceil 10
            Check.Eq(10, Trim.EstimateTokens([message]), "assistant+tool_calls");
        });
        Runner.Case("trim：未超限不动", () =>
        {
            var messages = new List<ChatMessage> { new ChatMessage { Role = "user", Content = "hi" } };
            Check.Eq(0, Trim.TrimContext(messages, 100_000), "不应裁剪");
        });
        Runner.Case("trim：裁最旧、保留最近 12 条、结构不动", () =>
        {
            var messages = new List<ChatMessage> { new ChatMessage { Role = "system", Content = "sys" } };
            for (var i = 0; i < 20; i++)
            {
                messages.Add(new ChatMessage { Role = "assistant", ToolCalls = [new ToolCall($"c{i}", "bash", "{}")] });
                messages.Add(ToolWith(300));
            }
            var before = messages.Count;
            var trimmed = Trim.TrimContext(messages, 100);

            Check.Eq(8, trimmed, "应只裁候选区（20-12）条");
            Check.Eq(before, messages.Count, "消息条数不应增减（配对结构完整）");
            Check.Eq(Trim.Placeholder, messages[2].Content, "最旧的工具输出应被替换");
            Check.Eq(Trim.Placeholder, messages[16].Content, "候选区最后一条也应被替换");
            Check.Eq(new string('x', 300), messages[18].Content, "最近 12 条不动");
        });
        Runner.Case("trim：幂等——再跑一遍不产生新裁剪", () =>
        {
            var messages = new List<ChatMessage> { new ChatMessage { Role = "system", Content = "sys" } };
            for (var i = 0; i < 20; i++)
            {
                messages.Add(new ChatMessage { Role = "assistant", ToolCalls = [new ToolCall($"c{i}", "bash", "{}")] });
                messages.Add(ToolWith(300));
            }
            Trim.TrimContext(messages, 100);
            Check.Eq(0, Trim.TrimContext(messages, 100), "第二次应不再裁剪");
        });
        Runner.Case("trim：占位文本本身不再被裁", () =>
        {
            var messages = new List<ChatMessage>
            {
                new ChatMessage { Role = "tool", ToolCallId = "a", Content = Trim.Placeholder },
                new ChatMessage { Role = "user", Content = new string('u', 5000) },
            };
            Check.Eq(0, Trim.TrimContext(messages, 10), "占位与 user 消息都不是候选");
        });
        Runner.Case("trim：空内容工具输出不裁——无可省内容，替换反而增加预算", () =>
        {
            var messages = new List<ChatMessage>
            {
                new ChatMessage { Role = "system", Content = "sys" },
                new ChatMessage { Role = "assistant", ToolCalls = [new ToolCall("e", "bash", "{}")] },
                ChatMessage.Tool("e", ""),
            };
            for (var i = 0; i < 30; i++)
            {
                messages.Add(new ChatMessage { Role = "assistant", ToolCalls = [new ToolCall($"c{i}", "bash", "{}")] });
                messages.Add(ToolWith(3000));
            }
            var trimmed = Trim.TrimContext(messages, 5000);

            Check.Eq(18, trimmed, "只裁 30 条大输出中最旧 18 条，空内容不计");
            Check.Eq("", messages[2].Content, "空内容 tool 消息不应被替换");
        });
    }
}
