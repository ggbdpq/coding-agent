// 路径守卫：解析模型给的路径，并标注目标是否越出当前工作目录。
// gcode 的安全边界是权限确认（人工把关），本模块的职责是把越界目标
// 显式带出来，让确认界面能看到 "../" 或绝对路径这类穿越意图，而不是静默放行。
// 非插件，是工具共享的工具函数。
package tools

import (
	"gcode/internal/kernel"
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

	return ResolvedPath{Abs: abs, Outside: !within(cwd, input)}
}

// InAllowWriteDirs 白名单判定（R4）：目标解析符号链接后落在 config allowWriteDirs
// 任一目录内（目录本身或其子路径）→ true。未配置/无法解析一律 false（仍逐次确认）。
// 只有 write/edit 接这个判定；bash/web_fetch 不设（命令级操作无法按路径约束）。
func InAllowWriteDirs(app *kernel.App, target string) bool {
	if app == nil || app.Config == nil {
		return false
	}

	for _, root := range app.Config.AllowWriteDirs {
		if within(root, target) {
			return true
		}
	}

	return false
}

// within 判断 p 的真实位置（解析符号链接后）是否在 root 的真实位置之内；任一侧解析失败按不在内处理。
func within(root, p string) bool {
	realRoot, err := realPath(root)
	if err != nil {
		return false
	}

	realP, err := realPath(p)
	if err != nil {
		return false
	}

	rel, err := filepath.Rel(realRoot, realP)

	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// realPath 是 filepath.Abs 加 EvalSymlinks；目标尚不存在时解析最近的已存在祖先再拼回余下部分。
// 存在却解析失败（悬空链接）返回错误：写入会跟随链接落到未知位置。
func realPath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}

	rest := ""

	for dir := abs; ; dir = filepath.Dir(dir) {
		resolved, err := filepath.EvalSymlinks(dir)
		if err == nil {
			return filepath.Join(resolved, rest), nil
		}

		if _, lerr := os.Lstat(dir); lerr == nil || filepath.Dir(dir) == dir {
			return "", err
		}

		rest = filepath.Join(filepath.Base(dir), rest)
	}
}
