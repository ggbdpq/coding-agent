// glob 工具：按 glob 模式列文件（ripgrep，尊重 .gitignore）。一工具一文件。
package tools

import (
	"context"

	"gcode/internal/kernel"
)

// NewGlob 构造 glob 工具插件。
func NewGlob() *kernel.ToolDef {
	return &kernel.ToolDef{
		Name:        "glob",
		Description: `按 glob 模式列文件（尊重 .gitignore），如 "*.ts"、"src/**/*.test.ts"`,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{"type": "string", "description": "glob 模式"},
			},
			"required": []string{"pattern"},
		},
		NeedsPermission: false,
		Preview:         func(args map[string]any) string { return "glob " + argString(args, "pattern") },
		Run: func(_ context.Context, args map[string]any) string {
			pattern := argString(args, "pattern")
			if pattern == "" {
				return "错误：缺少 pattern"
			}
			return runRg([]string{"--files", "-g", pattern}, 8000)
		},
	}
}
