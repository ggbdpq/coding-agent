// grep 工具：按正则搜文件内容（ripgrep，尊重 .gitignore）。一工具一文件。
package tools

import (
	"gocode/internal/kernel"
)

// NewGrep 构造 grep 工具插件。
func NewGrep() *kernel.ToolDef {
	return &kernel.ToolDef{
		Name:        "grep",
		Description: "按正则搜文件内容（ripgrep 语法，智能大小写），返回 行号:内容",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{"type": "string", "description": "正则表达式"},
				"path":    map[string]any{"type": "string", "description": "限定搜索的目录或文件，默认当前目录"},
				"include": map[string]any{"type": "string", "description": `文件名 glob 过滤，如 "*.ts"`},
			},
			"required": []string{"pattern"},
		},
		NeedsPermission: false,
		Preview:         func(args map[string]any) string { return "grep " + argString(args, "pattern") },
		Run: func(args map[string]any) string {
			pattern := argString(args, "pattern")
			if pattern == "" {
				return "错误：缺少 pattern"
			}
			rgArgs := []string{"-n", "-S"}
			if include := argString(args, "include"); include != "" {
				rgArgs = append(rgArgs, "-g", include)
			}
			rgArgs = append(rgArgs, "--", pattern, argString(args, "path"))
			if argString(args, "path") == "" {
				rgArgs[len(rgArgs)-1] = "."
			}
			return runRg(rgArgs, 8000)
		},
	}
}
