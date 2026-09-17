// 核心循环：一轮对话 = 往传入的 messages 推进，直到模型不再要工具。
// 不持有全局状态，方便测试与将来换壳（REPL/TUI/单发）。
// 注意：按分层规则 loop 不插件化（对齐 tcode Q4 决策）——它是这个项目的灵魂考点，
// 保持普通导出函数，接口化可替换但不进注册表。
use std::rc::Rc;

use serde_json::Value;

use crate::kernel::plugin::{to_schemas, ToolDef};
use crate::kernel::types::{ChatClient, ChatMessage, ChatOptions, ToolSchema};

/// 防失控：单轮对话最多允许的工具往返次数。
pub const MAX_TOOL_ROUNDS: usize = 40;

/// RunTurn 的依赖注入（壳侧回调统一 Rc，单线程模型见 ARCHITECTURE.md）。
pub struct TurnDeps {
    pub provider: Rc<dyn ChatClient>,
    pub tools: Vec<Rc<ToolDef>>,
    /// 权限闸门（needs_permission 的工具会被询问）；None 视为全部放行
    pub check: Option<Rc<dyn Fn(&str, &str) -> bool>>,
    pub on_text: Option<Rc<dyn Fn(&str)>>,
    pub on_tool_call: Option<Rc<dyn Fn(&str, &Value)>>,
    pub on_tool_result: Option<Rc<dyn Fn(&str, &str, u128)>>,
}

/// 推进 messages 直到模型不再要工具；40 轮熔断后不带工具再请求一次总结。
/// 工具错误一律以 "错误：..." 文本回流，不向上抛。
pub fn run_turn(messages: &mut Vec<ChatMessage>, deps: &TurnDeps) -> Result<(), String> {
    let schemas: Vec<ToolSchema> = to_schemas(&deps.tools);

    for _round in 0..MAX_TOOL_ROUNDS {
        let opts = ChatOptions { tools: schemas.clone(), on_text: deps.on_text.clone() };
        let res = deps.provider.chat(messages, &opts).map_err(|e| e.to_string())?;
        messages.push(res.message);
        let calls = messages.last().map_or_else(Vec::new, |m| m.tool_calls.clone());
        if calls.is_empty() {
            return Ok(());
        }

        for call in calls {
            let args = parse_args(&call.arguments);
            let tool = match deps.tools.iter().find(|t| t.name == call.name) {
                Some(t) => t.clone(),
                None => {
                    messages.push(ChatMessage::tool(
                        call.id.clone(),
                        format!(
                            "错误：未知工具 {}。可用工具：{}",
                            call.name,
                            deps.tools.iter().map(|t| t.name).collect::<Vec<_>>().join(", ")
                        ),
                    ));
                    continue;
                }
            };
            if let Some(cb) = &deps.on_tool_call {
                cb(tool.name, &args);
            }

            let allowed = if tool.needs_permission {
                match &deps.check {
                    Some(check) => check(tool.name, &(tool.preview)(&args)),
                    None => true,
                }
            } else {
                true
            };
            if !allowed {
                messages.push(ChatMessage::tool(
                    call.id.clone(),
                    "用户拒绝了本次操作。请询问用户怎么办，或换一种方式；不要未经允许重试同样的操作。",
                ));
                if let Some(cb) = &deps.on_tool_result {
                    cb(tool.name, "（用户已拒绝）", 0);
                }
                continue;
            }

            let t0 = std::time::Instant::now();
            let result = (tool.run)(&args);
            let ms = t0.elapsed().as_millis();
            messages.push(ChatMessage::tool(call.id.clone(), result.clone()));
            if let Some(cb) = &deps.on_tool_result {
                cb(tool.name, &result, ms);
            }
        }
    }

    // 轮次熔断：不带工具再要一次总结，防止无限打转
    let opts = ChatOptions { tools: vec![], on_text: deps.on_text.clone() };
    let res = deps.provider.chat(messages, &opts).map_err(|e| e.to_string())?;
    messages.push(res.message);
    Ok(())
}

/// 工具参数 JSON → Value；空/非法返回 Null（落下去让工具的"错误"文本纠正模型）。
fn parse_args(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return Value::Null;
    }
    serde_json::from_str(raw).unwrap_or(Value::Null)
}
