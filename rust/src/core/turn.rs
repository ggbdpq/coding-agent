// 一轮用户输入的完整编排：治理（压缩/裁剪）→ 入列 → 工具循环 → 断尾修复 → 会话落盘。
// 所有壳共用这里，保证治理/落盘/修复语义全项目只有一份。
// v1 事件模型：turn 是唯一生产者，经 emit 发出规范 AgentEvent（kernel/types），
// 壳只订阅不拼装——加功能=加事件变体，不动消费端接口。
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::agentloop::{run_turn, TurnDeps};
use super::compact::compact_context;
use super::trim::{estimate_tokens, trim_context};
use crate::kernel::app::App;
use crate::kernel::types::{AgentEvent, ChatMessage, TurnEndReason, Usage};

/// 壳侧回调：权限闸门（needs_permission 的工具会被询问）；None 视为全部放行。
/// 事件出口不再挂在 hooks 上——emit 作为 &mut dyn FnMut 直接传给 run_user_turn。
pub struct TurnHooks {
    pub check: Option<Rc<dyn Fn(&str, &str) -> bool>>,
}

/// 执行一轮用户输入；出错时先修复断尾再落盘，发 TurnEnd{Error} 后把错误交回壳展示。
/// 发射顺序对齐 tcode：compact/trimmed（若有）→ turn_start → user → 循环内
/// usage/text_delta/tool_call/tool_result → turn_end。
pub fn run_user_turn(
    app: &mut App,
    line: &str,
    hooks: &TurnHooks,
    emit: &mut dyn FnMut(AgentEvent),
) -> Result<(), String> {
    // 轮前上下文治理（双档）：估算超预算 80% 先试摘要压缩（保留任务目标与最近原文），
    // 压不动（失败/超时）再退裁剪（丢最旧工具输出兜底）。
    // 同步模型没有用户中止，compact 请求靠自身 20s 超时与错误路径收场。
    if estimate_tokens(&app.messages) > (app.config.context_limit as f64 * 0.8) as usize {
        match compact_context(app) {
            Ok(saved) => emit(AgentEvent::Compact { saved_tokens: saved }),
            Err(_) => {
                let cut = trim_context(&mut app.messages, app.config.context_limit);
                if cut > 0 {
                    emit(AgentEvent::Trimmed { count: cut });
                }
            }
        }
    }

    emit(AgentEvent::TurnStart { id: new_turn_id() });
    emit(AgentEvent::User { text: line.to_string() });

    app.messages.push(ChatMessage::user(line));
    let mark = app.messages.len() - 1;

    // 事件路由：&mut dyn FnMut 无法克隆进多个 Rc 回调（'static 约束）；
    // RefCell 包一层借用，四个回调共享同一个出口，运行时互斥。
    let outlet = RefCell::new(emit);
    let on_text = |delta: &str| {
        (*outlet.borrow_mut())(AgentEvent::TextDelta { delta: delta.to_string() });
    };
    let on_usage = |u: Usage| {
        (*outlet.borrow_mut())(AgentEvent::Usage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
        });
    };
    let on_tool_call = |call_id: &str, name: &str, args: &Value| {
        (*outlet.borrow_mut())(AgentEvent::ToolCall {
            call_id: call_id.to_string(),
            name: name.to_string(),
            args: args.clone(),
        });
    };
    let on_tool_result = |call_id: &str, name: &str, result: &str, ms: u64| {
        let summary = result.split('\n').next().unwrap_or("").to_string();
        (*outlet.borrow_mut())(AgentEvent::ToolResult {
            call_id: call_id.to_string(),
            name: name.to_string(),
            summary,
            ms,
        });
    };

    let deps = TurnDeps {
        check: hooks.check.clone(),
        on_text: Some(&on_text),
        on_tool_call: Some(&on_tool_call),
        on_tool_result: Some(&on_tool_result),
        on_usage: Some(&on_usage),
    };
    let result = run_turn(app, &deps);
    match result {
        Ok(()) => {
            append_since(app, mark);
            (*outlet.borrow_mut())(AgentEvent::TurnEnd {
                reason: TurnEndReason::Completed,
                error: None,
            });
            Ok(())
        }
        Err(e) => {
            // 出错可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法
            fix_dangling_tool_calls(&mut app.messages);
            append_since(app, mark);
            (*outlet.borrow_mut())(AgentEvent::TurnEnd {
                reason: TurnEndReason::Error,
                error: Some(e.clone()),
            });
            Err(e)
        }
    }
}

/// 轮次 id：毫秒时间戳 + 进程内自增（不引 uuid crate——依赖政策）。
fn new_turn_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("turn-{}-{}", millis, SEQ.fetch_add(1, Ordering::Relaxed))
}

fn append_since(app: &App, mark: usize) {
    let mut store = app.store.borrow_mut();
    for m in &app.messages[mark..] {
        store.append(m);
    }
}

/// 补齐"assistant 要了工具但没有回应"的断尾。
fn fix_dangling_tool_calls(messages: &mut Vec<ChatMessage>) {
    let last = match messages.last() {
        Some(m) if m.role == "assistant" && !m.tool_calls.is_empty() => m.clone(),
        _ => return,
    };
    let answered: Vec<String> = messages
        .iter()
        .filter(|m| m.role == "tool")
        .filter_map(|m| m.tool_call_id.clone())
        .collect();
    for tc in &last.tool_calls {
        if !answered.contains(&tc.id) {
            messages.push(ChatMessage::tool(tc.id.clone(), "（本轮出错，未执行）"));
        }
    }
}

#[cfg(test)]
mod tests {
    // 事件序列单测（镜像 tcode/test/events.test.ts 的规范序列例）：
    // 锁事件类型与顺序、turn_end 终态原因、落盘与事件互不干扰。
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;

    use serde_json::Value;

    use super::*;
    use crate::kernel::app::{create_app, AppOptions, SessionStoreLike, SessionSummary};
    use crate::kernel::config::Config;
    use crate::kernel::plugin::{Plugin, ProviderDef, Registry, ToolDef};
    use crate::kernel::types::{
        AgentEvent, ChatClient, ChatError, ChatOptions, CompletionResult, ToolCall, TurnEndReason,
    };

    /// 假会话存储：只记录 append 调用。
    struct FakeStore {
        appended: Vec<ChatMessage>,
    }

    impl Default for FakeStore {
        fn default() -> Self {
            FakeStore { appended: Vec::new() }
        }
    }

    impl SessionStoreLike for FakeStore {
        fn start(&mut self, _meta: Value) {}
        fn append(&mut self, message: &ChatMessage) {
            self.appended.push(message.clone());
        }
        fn list_recent(&self, _n: usize) -> Vec<SessionSummary> {
            vec![]
        }
        fn load(&self, _file: &str) -> Vec<ChatMessage> {
            vec![]
        }
    }

    /// 假 provider + 假工具经 create_app 装配出真 App（顺带覆盖装配路径）。
    fn fake_app(provider: Rc<dyn ChatClient>, store: Rc<RefCell<FakeStore>>) -> App {
        let mut registry = Registry::new();
        registry
            .register(Plugin::Provider(Rc::new(ProviderDef {
                name: "fake",
                matches: Rc::new(|_base_url: &str| true),
                create: Rc::new(move |_config| provider.clone()),
            })))
            .unwrap();
        registry
            .register(Plugin::Tool(Rc::new(ToolDef {
                name: "fake",
                description: "测试工具",
                parameters: serde_json::json!({"type": "object", "properties": {}}),
                needs_permission: false,
                preview: Rc::new(|_args: &Value| String::new()),
                run: Rc::new(|_args: &Value| "工具结果".to_string()),
                skip_permission: None,
            })))
            .unwrap();
        create_app(
            config(),
            registry,
            AppOptions { yolo: true, fresh_messages: Box::new(Vec::new), store },
        )
        .unwrap()
    }

    fn config() -> Config {
        Config {
            api_key: "k".into(),
            base_url: "http://127.0.0.1".into(),
            model: "fake".into(),
            protocol: None,
            approval: None,
            allow_write_dirs: vec![],
            context_limit: 1_000_000,
            rcode_dir: PathBuf::from("/tmp"),
        }
    }

    /// 两段式假客户端：没见过 tool 消息就要工具；见过则走 on_text 并给最终回答。
    struct ToolThenText;

    impl ChatClient for ToolThenText {
        fn chat(&self, messages: &[ChatMessage], opts: &ChatOptions) -> Result<CompletionResult, ChatError> {
            if !messages.iter().any(|m| m.role == "tool") {
                return Ok(CompletionResult {
                    message: ChatMessage::assistant(
                        None,
                        vec![ToolCall { id: "c1".into(), name: "fake".into(), arguments: "{}".into() }],
                    ),
                });
            }
            if let Some(cb) = &opts.on_text {
                cb("完成");
            }
            Ok(CompletionResult { message: ChatMessage::assistant(Some("完成".into()), vec![]) })
        }
    }

    /// 恒错的假客户端（同步模型下没有用户中止，provider 错误是唯一的非正常终态）。
    struct Failing(String);

    impl ChatClient for Failing {
        fn chat(&self, _messages: &[ChatMessage], _opts: &ChatOptions) -> Result<CompletionResult, ChatError> {
            Err(ChatError::Fatal(self.0.clone()))
        }
    }

    /// 摘要器 + 工具两段式：认出 compact 的摘要请求（system 开头是"你是会话摘要器"）
    /// 返回固定摘要；其余消息走 ToolThenText 的剧本。
    struct SummarizerThenTool;

    impl ChatClient for SummarizerThenTool {
        fn chat(&self, messages: &[ChatMessage], opts: &ChatOptions) -> Result<CompletionResult, ChatError> {
            if messages.first().map_or(false, |m| m.text().starts_with("你是会话摘要器")) {
                return Ok(CompletionResult {
                    message: ChatMessage::assistant(Some("这是摘要".into()), vec![]),
                });
            }
            if !messages.iter().any(|m| m.role == "tool") {
                return Ok(CompletionResult {
                    message: ChatMessage::assistant(
                        None,
                        vec![ToolCall { id: "c1".into(), name: "fake".into(), arguments: "{}".into() }],
                    ),
                });
            }
            if let Some(cb) = &opts.on_text {
                cb("完成");
            }
            Ok(CompletionResult { message: ChatMessage::assistant(Some("完成".into()), vec![]) })
        }
    }

    fn event_type(ev: &AgentEvent) -> &'static str {
        match ev {
            AgentEvent::TurnStart { .. } => "turn_start",
            AgentEvent::User { .. } => "user",
            AgentEvent::TextDelta { .. } => "text_delta",
            AgentEvent::ToolCall { .. } => "tool_call",
            AgentEvent::ToolResult { .. } => "tool_result",
            AgentEvent::Permission { .. } => "permission",
            AgentEvent::Trimmed { .. } => "trimmed",
            AgentEvent::Compact { .. } => "compact",
            AgentEvent::Usage { .. } => "usage",
            AgentEvent::TurnEnd { .. } => "turn_end",
        }
    }

    #[test]
    fn 规范序列_turn_start_user_tool_call_tool_result_text_delta_turn_end() {
        let store = Rc::new(RefCell::new(FakeStore::default()));
        let mut app = fake_app(Rc::new(ToolThenText), store.clone());
        let events: RefCell<Vec<AgentEvent>> = RefCell::new(Vec::new());
        {
            let mut emit = |ev: AgentEvent| events.borrow_mut().push(ev);
            let result = run_user_turn(&mut app, "做事", &TurnHooks { check: None }, &mut emit);
            assert!(result.is_ok());
        }
        let events = events.borrow();
        let types: Vec<&str> = events.iter().map(event_type).collect();
        assert_eq!(
            types,
            vec!["turn_start", "user", "tool_call", "tool_result", "text_delta", "turn_end"]
        );
        assert!(matches!(&events[0], AgentEvent::TurnStart { id } if !id.is_empty()), "turn_start 应带轮次 id");
        assert!(
            matches!(&events[2], AgentEvent::ToolCall { call_id, name, .. } if call_id == "c1" && name == "fake"),
            "tool_call 事件应带 call_id 与工具名"
        );
        assert!(
            matches!(&events[3], AgentEvent::ToolResult { summary, .. } if summary == "工具结果"),
            "tool_result 事件的 summary 是工具输出首行"
        );
        assert_eq!(
            events.last().unwrap(),
            &AgentEvent::TurnEnd { reason: TurnEndReason::Completed, error: None }
        );
        // 会话落盘与事件不冲突：user + assistant(tool_call) + tool + assistant 四条
        assert_eq!(store.borrow().appended.len(), 4);
    }

    /// 同步模型语义：provider 错误 → turn 发 TurnEnd{Error} 携带消息后把 Err 上抛给壳。
    #[test]
    fn provider错误_turn_end_error携带消息并上抛() {
        let mut app =
            fake_app(Rc::new(Failing("网络炸了".into())), Rc::new(RefCell::new(FakeStore::default())));
        let events: RefCell<Vec<AgentEvent>> = RefCell::new(Vec::new());
        {
            let mut emit = |ev: AgentEvent| events.borrow_mut().push(ev);
            let result = run_user_turn(&mut app, "做事", &TurnHooks { check: None }, &mut emit);
            let err = result.expect_err("provider 错误应上抛");
            assert!(err.contains("网络炸了"));
        }
        let events = events.borrow();
        assert_eq!(
            events.last().unwrap(),
            &AgentEvent::TurnEnd { reason: TurnEndReason::Error, error: Some("网络炸了".into()) }
        );
    }

    /// 轮前治理：估算超限 → compact 失败（provider 恒错）→ 退裁剪 → Trimmed 事件最前。
    #[test]
    fn 超限治理_compact失败退裁剪发Trimmed() {
        let mut app =
            fake_app(Rc::new(Failing("网络炸了".into())), Rc::new(RefCell::new(FakeStore::default())));
        app.config.context_limit = 1000;
        // system + user + 20 组（assistant(tool_call) + 3000 字符工具输出），估算远超 1000
        let mut messages = vec![ChatMessage::system("sys"), ChatMessage::user("hi")];
        for i in 0..20 {
            messages.push(ChatMessage::assistant(
                None,
                vec![ToolCall { id: format!("c{}", i), name: "fake".into(), arguments: "{}".into() }],
            ));
            messages.push(ChatMessage::tool(format!("c{}", i), "x".repeat(3000)));
        }
        app.messages = messages;

        let events: RefCell<Vec<AgentEvent>> = RefCell::new(Vec::new());
        {
            let mut emit = |ev: AgentEvent| events.borrow_mut().push(ev);
            let result = run_user_turn(&mut app, "做事", &TurnHooks { check: None }, &mut emit);
            assert!(result.is_err(), "provider 恒错，治理后本轮仍以错误收场");
        }
        let events = events.borrow();
        let types: Vec<&str> = events.iter().map(event_type).collect();
        assert_eq!(types, vec!["trimmed", "turn_start", "user", "turn_end"], "Trimmed 在 turn_start 之前");
        assert!(
            matches!(&events[0], AgentEvent::Trimmed { count } if *count > 0),
            "应裁掉早期工具输出"
        );
        assert!(
            matches!(events.last().unwrap(), AgentEvent::TurnEnd { reason: TurnEndReason::Error, .. }),
            "治理后本轮照常走 turn，终态为 error"
        );
    }

    /// 轮前治理双档：估算超预算 80% 先试 compact，成功发 Compact 事件且不再裁剪。
    #[test]
    fn 超限80_pct_compact成功_发Compact事件不裁剪() {
        let mut app =
            fake_app(Rc::new(SummarizerThenTool), Rc::new(RefCell::new(FakeStore::default())));
        app.config.context_limit = 100;
        // system + 3 组 user/assistant（每组约 300 字符），估算远超 80
        let mut messages = vec![ChatMessage::system("sys")];
        for i in 0..3 {
            messages.push(ChatMessage::user(format!("问题 {}：{}", i, "背景".repeat(100))));
            messages.push(ChatMessage::assistant(Some(format!("回答 {}：{}", i, "结论".repeat(100))), vec![]));
        }
        app.messages = messages;

        let events: RefCell<Vec<AgentEvent>> = RefCell::new(Vec::new());
        {
            let mut emit = |ev: AgentEvent| events.borrow_mut().push(ev);
            let result = run_user_turn(&mut app, "做事", &TurnHooks { check: None }, &mut emit);
            assert!(result.is_ok());
        }
        let events = events.borrow();
        let types: Vec<&str> = events.iter().map(event_type).collect();
        assert_eq!(
            types,
            vec!["compact", "turn_start", "user", "tool_call", "tool_result", "text_delta", "turn_end"],
            "Compact 在 turn_start 之前，且本轮照常完成"
        );
        assert!(
            matches!(&events[0], AgentEvent::Compact { saved_tokens } if *saved_tokens > 0),
            "compact 应返回正的节省 tokens"
        );
        assert!(!types.contains(&"trimmed"), "compact 成功后不应退裁剪");
    }

    /// Plan Mode 剧本 provider：第 1 次要 write、第 2 次要 read、之后给最终回答
    /// （镜像 tcode/test/planmode.test.ts 的两段式假客户端）。
    struct WriteThenRead;

    impl ChatClient for WriteThenRead {
        fn chat(&self, messages: &[ChatMessage], opts: &ChatOptions) -> Result<CompletionResult, ChatError> {
            let answered = messages.iter().filter(|m| m.role == "tool").count();
            if answered == 0 {
                return Ok(CompletionResult {
                    message: ChatMessage::assistant(
                        None,
                        vec![ToolCall { id: "c1".into(), name: "write".into(), arguments: "{}".into() }],
                    ),
                });
            }
            if answered == 1 {
                return Ok(CompletionResult {
                    message: ChatMessage::assistant(
                        None,
                        vec![ToolCall { id: "c2".into(), name: "read".into(), arguments: "{}".into() }],
                    ),
                });
            }
            if let Some(cb) = &opts.on_text {
                cb("完成");
            }
            Ok(CompletionResult { message: ChatMessage::assistant(Some("完成".into()), vec![]) })
        }
    }

    /// Plan Mode 剧本用 App：write（需确认）+ read（免确认）两个假工具。
    fn planmode_app(provider: Rc<dyn ChatClient>) -> App {
        let mut registry = Registry::new();
        registry
            .register(Plugin::Provider(Rc::new(ProviderDef {
                name: "fake",
                matches: Rc::new(|_base_url: &str| true),
                create: Rc::new(move |_config| provider.clone()),
            })))
            .unwrap();
        for (name, needs_permission, output) in
            [("write", true, "已写入"), ("read", false, "文件内容")]
        {
            registry
                .register(Plugin::Tool(Rc::new(ToolDef {
                    name,
                    description: "测试工具",
                    parameters: serde_json::json!({"type": "object", "properties": {}}),
                    needs_permission,
                    preview: Rc::new(|_args: &Value| String::new()),
                    run: Rc::new(move |_args: &Value| output.to_string()),
                    skip_permission: None,
                })))
                .unwrap();
        }
        create_app(
            config(),
            registry,
            AppOptions {
                yolo: true,
                fresh_messages: Box::new(Vec::new),
                store: Rc::new(RefCell::new(FakeStore::default())),
            },
        )
        .unwrap()
    }

    /// Plan Mode 单测一（镜像 planmode.test.ts 开启例）：写类工具轮内被拒并引导
    /// 产出计划（不发 tool_call 事件）、读类工具不受影响。
    #[test]
    fn planmode开启_写类工具被拒并引导_读类正常() {
        let mut app = planmode_app(Rc::new(WriteThenRead));
        app.plan_mode.set(true);
        let events: RefCell<Vec<AgentEvent>> = RefCell::new(Vec::new());
        {
            let mut emit = |ev: AgentEvent| events.borrow_mut().push(ev);
            let result = run_user_turn(&mut app, "做个计划", &TurnHooks { check: None }, &mut emit);
            assert!(result.is_ok());
        }
        let events = events.borrow();
        assert!(
            !events.iter().any(|ev| matches!(ev, AgentEvent::ToolCall { name, .. } if name == "write")),
            "write 被拒时不应发 tool_call 渲染事件"
        );
        let results: Vec<(&str, &str)> = events
            .iter()
            .filter_map(|ev| match ev {
                AgentEvent::ToolResult { name, summary, .. } => Some((name.as_str(), summary.as_str())),
                _ => None,
            })
            .collect();
        let write = results.iter().find(|(n, _)| *n == "write").expect("应有 write 回合");
        assert!(write.1.contains("Plan Mode"), "write 应被 Plan Mode 拒绝：{}", write.1);
        assert!(!write.1.contains("已写入"), "write 不应被执行：{}", write.1);
        let read = results.iter().find(|(n, _)| *n == "read").expect("应有 read 回合");
        assert!(read.1.contains("文件内容"), "read 不受影响：{}", read.1);
    }

    /// Plan Mode 单测二（镜像 planmode.test.ts 关闭例）：写类工具正常执行。
    #[test]
    fn planmode关闭_写类工具正常执行() {
        let mut app = planmode_app(Rc::new(WriteThenRead));
        let events: RefCell<Vec<AgentEvent>> = RefCell::new(Vec::new());
        {
            let mut emit = |ev: AgentEvent| events.borrow_mut().push(ev);
            let result = run_user_turn(&mut app, "直接写", &TurnHooks { check: None }, &mut emit);
            assert!(result.is_ok());
        }
        let events = events.borrow();
        let write = events.iter().find(|ev| matches!(ev, AgentEvent::ToolResult { name, .. } if name == "write"));
        assert!(
            matches!(write, Some(AgentEvent::ToolResult { summary, .. }) if summary.contains("已写入")),
            "关闭 Plan Mode 后 write 应正常执行"
        );
    }
}
