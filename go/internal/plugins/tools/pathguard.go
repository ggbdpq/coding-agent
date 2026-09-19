// 路径守卫：解析模型给的路径，并标注目标是否越出当前工作目录。
// gcode 的安全边界是权限确认（人工把关），本模块的职责是把越界目标
// 显式带出来，让确认界面能看到 "../" 或绝对路径这类穿越意图，而不是静默放行。
// 非插件，是工具共享的工具函数。
package tools

import (
	"os"
	"path/filepath"
	"strings"

	"gcode/internal/kernel"
)

// ResolvedPath 路径解析结果。
type ResolvedPath struct {
	Abs string
	// Outside true = 目标在当前工作目录之外，写类操作确认时会醒目提示
	Outside bool
}

// ResolvePath 把模型给的路径解析为绝对路径并判断是否越出工作目录。
func ResolvePath(input string) ResolvedPath {
	abs, err := filepath.Abs(input)
	if err != nil {
		abs = input
	}
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	rel, err := filepath.Rel(cwd, abs)
	outside := err != nil || strings.HasPrefix(rel, "..")
	return ResolvedPath{Abs: abs, Outside: outside}
}

// InAllowWriteDirs 白名单判定（R4）：目标 filepath.Abs 后落在 config allowWriteDirs
// 任一目录内（目录本身或其子路径）→ true。未配置/无法解析一律 false（仍逐次确认）。
// 只有 write/edit 接这个判定；bash/web_fetch 不设（命令级操作无法按路径约束）。
func InAllowWriteDirs(app *kernel.App, target string) bool {
	if app == nil || app.Config == nil || len(app.Config.AllowWriteDirs) == 0 {
		return false
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		return false
	}
	for _, root := range app.Config.AllowWriteDirs {
		if abs == root || strings.HasPrefix(abs, root+string(filepath.Separator)) {
			return true
		}
	}
	return false
}
