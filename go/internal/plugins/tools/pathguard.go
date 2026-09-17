// 路径守卫：解析模型给的路径，并标注目标是否越出当前工作目录。
// gocode 的安全边界是权限确认（人工把关），本模块的职责是把越界目标
// 显式带出来，让确认界面能看到 "../" 或绝对路径这类穿越意图，而不是静默放行。
// 非插件，是工具共享的工具函数。
package tools

import (
	"os"
	"path/filepath"
	"strings"
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
