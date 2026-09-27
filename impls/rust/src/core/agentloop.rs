// 核心循环：一轮对话 = 往传入的 messages 推进，直到模型不再要工具。
// 不持有全局状态，方便测试与将来换壳（REPL/TUI/单发）。
// 注意：按分层规则 loop 不插件化（对齐 tcode Q4 决策）——它是这个项目的灵魂考点，
// 保持普通导出函数，接口化可替换但不进注册表。
use std::rc::Rc;

use serde_json::Value;

use crate::kernel::app::App;
use crate::kernel::plugin::to_schemas;
use crate::kernel::types::{ChatMessage, ChatOptions, ToolSchema, Usage};

/// 防失控：单轮对话最多允许的工具往返次数。
pub const MAX_TOOL_ROUNDS: usize = 40;

/// RunTurn 的依赖注入。输出回调是借用（&dyn Fn）——只在同步调用栈内被调用，
/// 生命周期由调用方（turn 的栈帧）保证；权限闸门经 Rc 共享（壳侧 gate 需要克隆复用）。
/// 消息数组与工具/白名单环境（App）经 &mut App 传入：skip_permission 需要 &App，
/// Rust 的借用规则下"deps 持 &App + 同时借 &mut app.messages"无法共存，
/// 这是与 tcode（deps.app 可选字段）的结构性差异。
pub struct TurnDeps<'a> {
    /// 权限闸门（needs_permission 的工具会被询问）；None 视为全部放行
    pub check: Option<Rc<dyn Fn(&str, &str) -> bool>>,
    /// 正文增量 (delta)
    pub on_text: Option<&'a dyn Fn(&str)>,
    /// 工具调用 (call_id, name, args)
    pub on_tool_call: Option<&'a dyn Fn(&str, &str, &Value)>,
    /// 工具结果 (call_id, name, 原始输出, 耗时 ms)
    pub on_tool_result: Option<&'a dyn Fn(&str, &str, &str, u64)>,
    /// token 用量 (R5)：每次补全都可能触发，turn 层转成 usage 事件
    pub on_usage: Option<&'a dyn Fn(Usage)>,
}

/// 推进 messages 直到模型不再要工具；40 轮熔断后不带工具再请求一次总结。
/// 工具错误一律以 "错误：..." 文本回流，不向上抛。
pub fn run_turn(app: &mut App, deps: &TurnDeps) -> Result<(), String> {
    let provider = app.provider.clone();
    let tools = app.registry.tools();
    let schemas: Vec<ToolSchema> = to_schemas(&tools);

    for _round in 0..MAX_TOOL_ROUNDS {
        let opts = ChatOptions {
            tools: schemas.clone(),
            on_text: deps.on_text,
            on_usage: deps.on_usage,
            timeout: None,
        };
        let res = provider.chat(&app.messages, &opts).map_err(|e| e.to_string())?;
        app.messages.push(res.message);
        let calls = app.messages.last().map_or_else(Vec::new, |m| m.tool_calls.clone());
        if calls.is_empty() {
            return Ok(());
        }

        for call in calls {
            let args = parse_args(&call.arguments);
            let tool = match tools.iter().find(|t| t.name == call.name) {
                Some(t) => t.clone(),
                None => {
                    app.messages.push(ChatMessage::tool(
                        call.id.clone(),
                        format!(
                            "错误：未知工具 {}。可用工具：{}",
                            call.name,
                            tools.iter().map(|t| t.name).collect::<Vec<_>>().join(", ")
                        ),
                    ));
                    continue;
                }
            };
            // Plan Mode（只读规划）：写类工具拒绝执行，引导模型产出计划。
            // 判定在白名单与权限询问之前：plan_mode 开启时写类工具不执行、
            // 不触发确认、不发 tool_call 渲染事件，只回拒写文本 + tool_result 事件。
            if app.plan_mode.get() && tool.needs_permission {
                let deny = "当前处于 Plan Mode（只读规划）：禁止执行写类操作。请继续只读探索，并输出一份分步计划；完成后告知用户用 /plan 切回普通模式执行。";
                app.messages.push(ChatMessage::tool(call.id.clone(), deny));
                if let Some(cb) = deps.on_tool_result {
                    cb(&call.id, tool.name, deny, 0);
                }
                continue;
            }
            if let Some(cb) = deps.on_tool_call {
                cb(&call.id, &tool.name, &args);
            }

            // 白名单优先（skip_permission 声明受信）→ 闸门逐次确认（R4）
            let trusted = tool.skip_permission.as_ref().map_or(false, |f| f(&args, app));
            let allowed = if tool.needs_permission {
                match (&deps.check, trusted) {
                    (Some(check), false) => check(tool.name, &(tool.preview)(&args)),
                    _ => true,
                }
            } else {
                true
            };
            if !allowed {
                app.messages.push(ChatMessage::tool(
                    call.id.clone(),
                    "用户拒绝了本次操作。请询问用户怎么办，或换一种方式；不要未经允许重试同样的操作。",
                ));
                if let Some(cb) = deps.on_tool_result {
                    cb(&call.id, tool.name, "（用户已拒绝）", 0);
                }
                continue;
            }

            let t0 = std::time::Instant::now();
            let result = (tool.run)(&args);
            let ms = t0.elapsed().as_millis() as u64;
            app.messages.push(ChatMessage::tool(call.id.clone(), result.clone()));
            if let Some(cb) = deps.on_tool_result {
                cb(&call.id, tool.name, &result, ms);
            }
        }
    }

    // 轮次熔断：不带工具再要一次总结，防止无限打转
    let opts = ChatOptions {
        tools: vec![],
        on_text: deps.on_text,
        on_usage: deps.on_usage,
        timeout: None,
    };
    let res = provider.chat(&app.messages, &opts).map_err(|e| e.to_string())?;
    app.messages.push(res.message);
    Ok(())
}

/// 工具参数 JSON → Value；空/非法返回 Null（落下去让工具的"错误"文本纠正模型）。
fn parse_args(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return Value::Null;
    }
    serde_json::from_str(raw).unwrap_or(Value::Null)
}
