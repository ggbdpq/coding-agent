// 一轮用户输入的完整编排：裁剪 → 入列 → 工具循环 → 断尾修复 → 会话落盘。
// 所有壳共用这里，保证裁剪/落盘/修复语义全项目只有一份。
use std::rc::Rc;

use serde_json::Value;

use super::agentloop::{run_turn, TurnDeps};
use super::trim::trim_context;
use crate::kernel::app::App;
use crate::kernel::types::ChatMessage;

/// 壳侧回调。
pub struct TurnHooks {
    /// 权限闸门（needs_permission 的工具会被询问）；None 视为全部放行
    pub check: Option<Rc<dyn Fn(&str, &str) -> bool>>,
    pub on_text: Option<Rc<dyn Fn(&str)>>,
    pub on_tool_call: Option<Rc<dyn Fn(&str, &Value)>>,
    pub on_tool_result: Option<Rc<dyn Fn(&str, &str, u128)>>,
    /// 上下文被裁剪时通知壳（REPL 打灰字）
    pub on_trimmed: Option<Rc<dyn Fn(usize)>>,
}

impl Default for TurnHooks {
    fn default() -> Self {
        TurnHooks { check: None, on_text: None, on_tool_call: None, on_tool_result: None, on_trimmed: None }
    }
}

/// 执行一轮用户输入；出错时先修复断尾再落盘，然后把错误交回壳展示。
pub fn run_user_turn(app: &mut App, line: &str, hooks: &TurnHooks) -> Result<(), String> {
    // 轮前裁剪：只影响发给模型的上下文；会话文件里保留完整历史
    let cut = trim_context(&mut app.messages, app.config.context_limit);
    if cut > 0 {
        if let Some(cb) = &hooks.on_trimmed {
            cb(cut);
        }
    }

    app.messages.push(ChatMessage::user(line));
    let mark = app.messages.len() - 1;

    let deps = TurnDeps {
        provider: app.provider.clone(),
        tools: app.registry.tools(),
        check: hooks.check.clone(),
        on_text: hooks.on_text.clone(),
        on_tool_call: hooks.on_tool_call.clone(),
        on_tool_result: hooks.on_tool_result.clone(),
    };
    let result = run_turn(&mut app.messages, &deps);
    match result {
        Ok(()) => {
            append_since(app, mark);
            Ok(())
        }
        Err(e) => {
            // 出错可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法
            fix_dangling_tool_calls(&mut app.messages);
            append_since(app, mark);
            Err(e)
        }
    }
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
            messages.push(ChatMessage::tool(tc.id.clone(), "（用户中止，未执行）"));
        }
    }
}
