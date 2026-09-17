// 权限闸门：write/edit/bash/web_fetch 等写类操作逐次确认；--yolo / 回答"本会话全部允许"放行整个会话。
// 这是 rcode 的核心安全边界。闸门语义全项目只有这一份：
// 壳（REPL）只提供 ask 的 UI 适配，返回 allow/deny/always 三态决定。
// 按分层规则留在 core：安全边界不开放替换，也不进插件注册表。
use std::cell::Cell;
use std::rc::Rc;

/// 权限询问的三态决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    /// 放行本次
    Allow,
    /// 拒绝本次
    Deny,
    /// 本会话全部允许（置 yolo）
    Always,
}

/// 一次权限询问。
pub struct PermissionRequest {
    pub tool: String,
    pub preview: String,
}

/// 壳侧 UI 适配接口。
pub trait PermissionIO {
    fn ask(&self, req: PermissionRequest) -> PermissionDecision;
}

/// 返回统一闸门函数；always 决定会置 yolo（本会话后续免确认）。
pub fn create_permission_gate(
    io: Rc<dyn PermissionIO>,
    yolo: Rc<Cell<bool>>,
) -> Rc<dyn Fn(&str, &str) -> bool> {
    Rc::new(move |tool_name: &str, preview: &str| {
        if yolo.get() {
            return true;
        }
        let decision = io.ask(PermissionRequest {
            tool: tool_name.to_string(),
            preview: preview.to_string(),
        });
        if decision == PermissionDecision::Always {
            yolo.set(true);
        }
        decision != PermissionDecision::Deny
    })
}
