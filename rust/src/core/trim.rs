// 上下文预算：粗估 token（不引分词器依赖），超限时从最旧的工具输出裁起。
// 只动 tool 消息的 content，消息结构不动——assistant/tool_calls 与 tool 回应的
// 配对关系保持完整，后续请求对 API 依然合法。

use crate::kernel::types::ChatMessage;

/// 保留最近多少条工具消息不动。
const KEEP_RECENT_TOOLS: usize = 12;

/// 裁剪占位文本（模型能看懂发生了什么）。
pub const TRIM_PLACEHOLDER: &str = "[早期工具输出已省略以释放上下文]";

/// 粗估 token：按 3 字符 ≈ 1 token 折中（英文约 4 字符/词、中文更密），
/// 另计每条消息与每个 tool_call 的固定开销。
pub fn estimate_tokens(messages: &[ChatMessage]) -> usize {
    let mut chars = 0usize;
    for m in messages {
        chars += m.content.as_deref().map_or(0, |s| s.chars().count()) + 8;
        for tc in &m.tool_calls {
            chars += tc.name.chars().count() + tc.arguments.chars().count() + 8;
        }
    }
    (chars + 2) / 3 // 向上取整
}

/// 就地裁剪，返回被裁的消息条数；保留最近 KEEP_RECENT_TOOLS 条工具输出，
/// 裁完仍超限就到顶。占位消息不重复裁（幂等）。
pub fn trim_context(messages: &mut [ChatMessage], limit: usize) -> usize {
    if estimate_tokens(messages) <= limit {
        return 0;
    }
    let mut tool_idx: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == "tool")
        .map(|(i, _)| i)
        .collect();
    // 只留"允许被裁"的候选：去掉最近 KEEP_RECENT_TOOLS 条
    if tool_idx.len() > KEEP_RECENT_TOOLS {
        tool_idx.truncate(tool_idx.len() - KEEP_RECENT_TOOLS);
    } else {
        tool_idx.clear();
    }
    let mut trimmed = 0;
    for &i in &tool_idx {
        if estimate_tokens(messages) <= limit {
            break;
        }
        if let Some(c) = messages[i].content.as_mut() {
            if c != TRIM_PLACEHOLDER {
                *c = TRIM_PLACEHOLDER.to_string();
                trimmed += 1;
            }
        }
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::ToolCall;

    /// 构造一组 assistant(tool_call) + tool(大输出) 消息。
    fn exchange(i: usize, size: usize) -> Vec<ChatMessage> {
        vec![
            ChatMessage::assistant(
                None,
                vec![ToolCall {
                    id: format!("c{}", i),
                    name: "bash".into(),
                    arguments: "{}".into(),
                }],
            ),
            ChatMessage::tool(format!("c{}", i), "x".repeat(size)),
        ]
    }

    #[test]
    fn 估算随内容增长() {
        let small = vec![ChatMessage::user("hi")];
        let big = vec![ChatMessage::user("x".repeat(3000))];
        assert!(estimate_tokens(&big) > estimate_tokens(&small) * 100);
    }

    #[test]
    fn 不超限时不裁任何内容() {
        let mut messages = vec![ChatMessage::system("sys")];
        messages.extend(exchange(0, 100));
        let trimmed = trim_context(&mut messages, usize::MAX);
        assert_eq!(trimmed, 0);
    }

    #[test]
    fn 超限裁剪_旧输出变占位_最近12条保留_配对结构完整() {
        let mut messages = vec![ChatMessage::system("sys"), ChatMessage::user("hi")];
        for i in 0..30 {
            messages.extend(exchange(i, 3000));
        }

        let trimmed = trim_context(&mut messages, 5000);
        let tools: Vec<&ChatMessage> = messages.iter().filter(|m| m.role == "tool").collect();
        let placeholder_count = tools
            .iter()
            .filter(|m| m.content.as_deref() == Some(TRIM_PLACEHOLDER))
            .count();
        assert_eq!(trimmed, placeholder_count);
        assert_eq!(trimmed, 18, "30 条工具消息，保留最近 12 条，应裁最旧 18 条");
        assert!(
            tools[tools.len() - 12..]
                .iter()
                .all(|m| m.content.as_deref() != Some(TRIM_PLACEHOLDER)),
            "最近 12 条不应被裁"
        );

        // API 合法性：每个 assistant 的 tool_call 后必须紧跟同 id 的 tool 回应
        for i in 0..messages.len() {
            let m = &messages[i];
            if m.role == "assistant" {
                for tc in &m.tool_calls {
                    let next = messages.get(i + 1);
                    assert!(
                        next.map_or(false, |n| n.role == "tool" && n.tool_call_id.as_deref() == Some(tc.id.as_str())),
                        "消息 {} 的工具调用 {} 没有紧邻回应",
                        i,
                        tc.id
                    );
                }
            }
        }
    }

    #[test]
    fn 重复裁剪幂等() {
        let mut messages = vec![ChatMessage::system("s")];
        for i in 0..20 {
            messages.extend(exchange(i, 3000));
        }
        trim_context(&mut messages, 5000);
        let trimmed = trim_context(&mut messages, 5000);
        assert_eq!(trimmed, 0, "占位消息不应被二次裁剪");
    }
}
