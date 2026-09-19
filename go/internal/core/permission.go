// 权限闸门：write/edit/bash/web_fetch 等写类操作逐次确认；--yolo / 回答"本会话全部允许"放行整个会话。
// 这是 gcode 的核心安全边界。闸门语义全项目只有这一份：
// 壳（REPL）只提供 Ask 的 UI 适配，返回 allow/deny/always 三态决定。
// 按分层规则留在 core：安全边界不开放替换，也不进插件注册表。
package core

import "gcode/internal/kernel"

// PermissionDecision 权限询问的三态决定。
type PermissionDecision string

const (
	DecisionAllow  PermissionDecision = "allow"  // 放行本次
	DecisionDeny   PermissionDecision = "deny"   // 拒绝本次
	DecisionAlways PermissionDecision = "always" // 本会话全部允许（置 yolo）
)

// PermissionRequest 一次权限询问。
type PermissionRequest struct {
	Tool    string
	Preview string
}

// PermissionIO 壳侧 UI 适配接口。
type PermissionIO interface {
	Ask(req PermissionRequest) PermissionDecision
}

// PermissionIOFunc 函数适配器：把闭包变成 PermissionIO。
type PermissionIOFunc func(req PermissionRequest) PermissionDecision

// Ask 实现 PermissionIO。
func (f PermissionIOFunc) Ask(req PermissionRequest) PermissionDecision { return f(req) }

// NewPermissionGate 返回统一闸门函数；always 决定会置 yolo（本会话后续免确认）。
func NewPermissionGate(io PermissionIO, yolo *kernel.YoloRef) func(toolName, preview string) bool {
	return func(toolName, preview string) bool {
		if yolo.Value {
			return true
		}
		decision := io.Ask(PermissionRequest{Tool: toolName, Preview: preview})
		if decision == DecisionAlways {
			yolo.Value = true
		}
		return decision != DecisionDeny
	}
}
