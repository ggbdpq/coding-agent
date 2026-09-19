// 上下文压缩（蓝图 R3，v0.4 打磨）：调当前模型把旧对话压成摘要，历史替换为
// [system, 摘要消息, 最近 TAIL_KEEP 条原文]。trim（裁旧丢历史）降级为 compact
// 失败时的兜底（见 core/turn.rs 的轮前治理）。
// 纪律：摘要失败时原 messages 原封不动——compact 永不破坏会话。
// 尾部切片点必须落在 user 消息上（配对安全：tool 不悬空、不打断 tool_call 配对）。
// 同步模型差异（对照 tcode）：stdlib 没有用户中止信号（Ctrl+C 处理器需第三方 crate，
// 违反两依赖政策），摘要请求靠 ChatOptions.timeout 兜底，走同一个 provider。
use std::time::Duration;

use crate::core::trim::estimate_tokens;
use crate::kernel::app::App;
use crate::kernel::types::{ChatMessage, ChatOptions};

/// system + 至少 4 条对话才值得压缩。
const MIN_MESSAGES: usize = 5;
/// 摘要之外保留最近多少条原文（摘要之外，任务细节不丢）。
const TAIL_KEEP: usize = 4;
/// 摘要请求整体超时：同步模型没有用户中止，超时就是"取消"。
const SUMMARY_TIMEOUT: Duration = Duration::from_secs(20);
const SUMMARY_SYSTEM: &str = "你是会话摘要器：只输出摘要正文，用简体中文，尽量精炼。";
const SUMMARY_PROMPT: &str = "请把下面的对话历史压缩成一份简洁的任务摘要，供后续工作参考。\
必须保留：当前任务目标、已完成的关键步骤、重要文件路径与结论、尚未完成的事项。\
直接输出摘要正文，不要客套。";

/// 尾部起点必须从 user 消息开始（配对安全）：从 idealStart（含）向后扫最近的
/// user 下标；找不到 user 边界则返回 len(messages)——不保留尾巴。
fn pick_tail_start(messages: &[ChatMessage], ideal_start: usize) -> usize {
    for (i, m) in messages.iter().enumerate().skip(ideal_start.max(1)) {
        if m.role == "user" {
            return i;
        }
    }
    messages.len()
}

/// 压缩当前会话历史为 [system, 摘要, 最近 4 条原文]；成功返回省下的估算 token 数，
/// 失败时原历史原封不动。
pub fn compact_context(app: &mut App) -> Result<u64, String> {
    if app.messages.len() <= MIN_MESSAGES {
        return Err("对话太短，没什么可压缩的".into());
    }
    let before = estimate_tokens(&app.messages);

    // transcript = messages[1:] 的 "role: content" 拼接（system 提示词不进摘要）
    let transcript = app.messages[1..]
        .iter()
        .map(|m| match &m.content {
            Some(c) => format!("{}: {}", m.role, c),
            // 无正文的 assistant 消息（只有 tool_calls）按 tcode 同款占位
            None => format!("{}: (tool_calls: {} 个)", m.role, m.tool_calls.len()),
        })
        .collect::<Vec<_>>()
        .join("\n");

    let request = vec![
        ChatMessage::system(SUMMARY_SYSTEM),
        ChatMessage::user(format!("{}\n\n--- 对话历史 ---\n{}", SUMMARY_PROMPT, transcript)),
    ];
    let opts = ChatOptions { timeout: Some(SUMMARY_TIMEOUT), ..Default::default() };
    let summary = match app.provider.chat(&request, &opts) {
        Ok(r) => r.message.content,
        Err(e) => return Err(e.to_string()),
    };
    let summary = match summary {
        Some(s) if !s.trim().is_empty() => s,
        _ => return Err("模型返回了空摘要".into()),
    };

    // 成功才动历史：system + 摘要 user 消息 + 尾部原文（切片点配对安全）
    let ideal = app.messages.len().saturating_sub(TAIL_KEEP);
    let tail_start = pick_tail_start(&app.messages, ideal);
    let tail: Vec<ChatMessage> = app.messages[tail_start..].to_vec();
    let summary_msg = ChatMessage::user(format!(
        "[此前对话的摘要——当前任务以此为背景继续]\n{}\n[摘要结束]",
        summary
    ));
    app.messages.truncate(1);
    app.messages.push(summary_msg);
    app.messages.extend(tail);
    Ok(before.saturating_sub(estimate_tokens(&app.messages)) as u64)
}

#[cfg(test)]
mod tests {
    // compact 单测（镜像 tcode/test/compact.test.ts 四例）：
    // 替换+saved_tokens>0 / 太短拒绝且原状 / 摘要失败原状 / 空摘要原状
    // （tcode 的"用户中止"例在同步模型下没有对应路径，按任务口径改为 provider 错误原状）。
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;

    use serde_json::Value;

    use super::*;
    use crate::kernel::app::{create_app, AppOptions, SessionStoreLike, SessionSummary};
    use crate::kernel::config::Config;
    use crate::kernel::plugin::{Plugin, ProviderDef, Registry};
    use crate::kernel::types::{ChatClient, ChatError, CompletionResult, ToolCall};

    struct FakeStore;

    impl SessionStoreLike for FakeStore {
        fn start(&mut self, _meta: Value) {}
        fn append(&mut self, _message: &ChatMessage) {}
        fn list_recent(&self, _n: usize) -> Vec<SessionSummary> {
            vec![]
        }
        fn load(&self, _file: &str) -> Vec<ChatMessage> {
            vec![]
        }
    }

    fn fake_app(provider: Rc<dyn ChatClient>) -> App {
        let mut registry = Registry::new();
        registry
            .register(Plugin::Provider(Rc::new(ProviderDef {
                name: "fake",
                matches: Rc::new(|_base_url: &str| true),
                create: Rc::new(move |_config| provider.clone()),
            })))
            .unwrap();
        create_app(
            Config {
                api_key: "k".into(),
                base_url: "http://127.0.0.1".into(),
                model: "fake".into(),
                protocol: None,
                approval: None,
                allow_write_dirs: vec![],
                context_limit: 1_000_000,
                rcode_dir: PathBuf::from("/tmp"),
            },
            registry,
            AppOptions { yolo: true, fresh_messages: Box::new(Vec::new), store: Rc::new(RefCell::new(FakeStore)) },
        )
        .unwrap()
    }

    /// 固定摘要的假 summarizer（provider 抽象即注入点）。
    struct Summarizer;

    impl ChatClient for Summarizer {
        fn chat(&self, _messages: &[ChatMessage], _opts: &ChatOptions) -> Result<CompletionResult, ChatError> {
            Ok(CompletionResult { message: ChatMessage::assistant(Some("这是摘要".into()), vec![]) })
        }
    }

    /// 恒错的假 provider。
    struct Failing(String);

    impl ChatClient for Failing {
        fn chat(&self, _messages: &[ChatMessage], _opts: &ChatOptions) -> Result<CompletionResult, ChatError> {
            Err(ChatError::Fatal(self.0.clone()))
        }
    }

    /// 空摘要的假 provider（content: null）。
    struct Empty;

    impl ChatClient for Empty {
        fn chat(&self, _messages: &[ChatMessage], _opts: &ChatOptions) -> Result<CompletionResult, ChatError> {
            Ok(CompletionResult { message: ChatMessage::assistant(None, vec![]) })
        }
    }

    fn history() -> Vec<ChatMessage> {
        let mut msgs = vec![ChatMessage::system("系统提示")];
        for i in 0..10 {
            msgs.push(ChatMessage::user(format!("问题 {}", i)));
            msgs.push(ChatMessage::assistant(Some(format!("回答 {}", i)), vec![]));
        }
        msgs
    }

    #[test]
    fn 压缩成功_摘要加保留最近4条原文_返回节省tokens() {
        let mut app = fake_app(Rc::new(Summarizer));
        let messages = history();
        let before_len = messages.len();
        app.messages = messages.clone();

        let saved = compact_context(&mut app).unwrap();

        assert!(saved > 0, "前后估算差应 > 0，实际 {}", saved);
        assert_eq!(app.messages.len(), 6, "system + 摘要 + 最近 4 条原文");
        assert_eq!(app.messages[0].role, "system");
        assert_eq!(app.messages[0].text(), "系统提示");
        let summary_msg = app.messages[1].text();
        assert!(summary_msg.contains("这是摘要"), "摘要正文应进消息：{}", summary_msg);
        assert!(summary_msg.starts_with("[此前对话的摘要——当前任务以此为背景继续]"));
        assert!(summary_msg.ends_with("[摘要结束]"));
        // 最近 4 条原文保留：tail 从 user 边界开始，内容与原末尾一致
        assert_eq!(app.messages[2].role, "user");
        assert_eq!(&app.messages[2..], &messages[messages.len() - 4..]);
        assert!(before_len > app.messages.len());
    }

    /// 镜像 tcode/test/compact.test.ts 的配对安全切片例：
    /// 理想切点（len-4=6）恰为 tool 消息时，尾部必须从其后最近的 user（idx7）开始。
    #[test]
    fn 配对安全切片_理想切点落在tool消息上时向后扫描到user() {
        let messages = vec![
            ChatMessage::system("系统提示"),
            ChatMessage::user("u1"),
            ChatMessage::assistant(
                None,
                vec![ToolCall { id: "c1".into(), name: "bash".into(), arguments: "{}".into() }],
            ),
            ChatMessage::tool("c1", "r1"),
            ChatMessage::user("u2"),
            ChatMessage::assistant(
                None,
                vec![ToolCall { id: "c2".into(), name: "bash".into(), arguments: "{}".into() }],
            ),
            ChatMessage::tool("c2", "r2"),
            ChatMessage::user("u3"),
            ChatMessage::assistant(Some("a3".into()), vec![]),
            ChatMessage::user("u4"),
        ];
        let mut app = fake_app(Rc::new(Summarizer));
        app.messages = messages;

        compact_context(&mut app).unwrap();

        assert_eq!(app.messages.len(), 5, "system + 摘要 + 3 条尾部（len-4=6 的 tool 不作切点）");
        assert_eq!(app.messages[2].text(), "u3");
        assert!(
            !app.messages.iter().any(|m| m.role == "tool"),
            "摘要区已展平，无悬空 tool 消息"
        );
    }

    #[test]
    fn 历史太短_拒绝且保持原状() {
        let mut app = fake_app(Rc::new(Summarizer));
        app.messages = vec![
            ChatMessage::system("s"),
            ChatMessage::user("a"),
            ChatMessage::assistant(Some("b".into()), vec![]),
        ];

        let err = compact_context(&mut app).unwrap_err();

        assert!(err.contains("没什么可压缩"), "实际：{}", err);
        assert_eq!(app.messages.len(), 3, "拒绝时原历史原封不动");
    }

    #[test]
    fn 摘要失败_原历史原封不动() {
        let messages = history();
        let snapshot = messages.clone();
        let mut app = fake_app(Rc::new(Failing("网络炸了".into())));
        app.messages = messages;

        let err = compact_context(&mut app).unwrap_err();

        assert!(err.contains("网络炸了"), "实际：{}", err);
        assert_eq!(app.messages, snapshot, "失败时历史必须与快照逐条一致");
    }

    /// tcode 的"用户中止原状"例在同步模型下没有对应路径；
    /// 同口径改为 provider 异常返回（空摘要）——同样必须原状。
    #[test]
    fn 空摘要_原历史原封不动() {
        let messages = history();
        let snapshot = messages.clone();
        let mut app = fake_app(Rc::new(Empty));
        app.messages = messages;

        let err = compact_context(&mut app).unwrap_err();

        assert!(err.contains("空摘要"), "实际：{}", err);
        assert_eq!(app.messages.len(), snapshot.len(), "失败时历史长度不变");
        assert_eq!(app.messages, snapshot);
    }
}
