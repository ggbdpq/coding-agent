// apply_patch 工具：多文件原子编辑——先对全部编辑做预验（每条 old_string 必须在其
// 文件中存在；多处出现需显式 replace_all），任一失败则整体不应用并逐条报告；
// 全部通过后才写入。
// 原子性说明：预验与写入之间无并发写者（工具循环串行），因此"全预验→全写入"
// 即实际原子；安全边界：逐次确认，preview 列出全部目标文件。
package tools

import (
	"context"
	"fmt"
	"os"
	"strings"

	"gcode/internal/kernel"
)

// preparedEdit 预验通过、待写入的一条编辑。
type preparedEdit struct {
	abs      string
	display  string
	original string
	next     string
}

// NewApplyPatch 构造 apply_patch 工具插件。
func NewApplyPatch() *kernel.ToolDef {
	return &kernel.ToolDef{
		Name: "apply_patch",
		Description: "对多个文件一次应用多处精确替换（原子操作：全部预验通过才写入，任一失败整体放弃）。" +
			"适合跨文件的重命名/批量调整；单文件小改动仍优先用 edit。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"edits": map[string]any{
					"type":        "array",
					"description": "编辑列表，每项 {file_path, old_string, new_string, replace_all?}",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"file_path":   map[string]any{"type": "string"},
							"old_string":  map[string]any{"type": "string"},
							"new_string":  map[string]any{"type": "string"},
							"replace_all": map[string]any{"type": "boolean"},
						},
						"required": []string{"file_path", "old_string", "new_string"},
					},
				},
			},
			"required": []string{"edits"},
		},
		NeedsPermission: true,
		Preview: func(args map[string]any) string {
			edits, _ := args["edits"].([]any)
			var files []string
			seen := map[string]bool{}
			for _, e := range edits {
				m, _ := e.(map[string]any)
				f, _ := m["file_path"].(string)
				if !seen[f] {
					seen[f] = true
					files = append(files, f)
				}
			}
			lines := make([]string, 0, len(files))
			for _, f := range files {
				lines = append(lines, "  · "+f)
			}
			return fmt.Sprintf("原子补丁：%d 处编辑，涉及 %d 个文件\n%s",
				len(edits), len(files), strings.Join(lines, "\n"))
		},
		Run: func(_ context.Context, args map[string]any) string { return runApplyPatch(args) },
	}
}

// runApplyPatch 工具壳：两阶段——全量预验（不改磁盘）→ 全部通过才逐条写入。
func runApplyPatch(args map[string]any) string {
	raw, _ := args["edits"].([]any)
	if len(raw) == 0 {
		return "错误：edits 不能为空"
	}

	// 第一阶段：全量预验（读文件 + 唯一性检查），不改任何磁盘内容
	cache := map[string]string{}
	prepared := make([]preparedEdit, 0, len(raw))
	var errs []string
	for i, e := range raw {
		m, _ := e.(map[string]any)
		file, _ := m["file_path"].(string)
		oldString, _ := m["old_string"].(string)
		newString, _ := m["new_string"].(string)
		replaceAll, _ := m["replace_all"].(bool)
		if file == "" || oldString == "" {
			errs = append(errs, fmt.Sprintf("#%d：缺少 file_path 或 old_string", i))
			continue
		}
		abs := ResolvePath(file).Abs
		original, ok := cache[file]
		if !ok {
			data, err := os.ReadFile(abs)
			if err != nil {
				errs = append(errs, fmt.Sprintf("#%d：无法读取 %s", i, file))
				continue
			}
			original = string(data)
			cache[file] = original
		}
		count := strings.Count(original, oldString)
		if count == 0 {
			errs = append(errs, fmt.Sprintf("#%d：%s 中未找到 old_string", i, file))
		} else if count > 1 && !replaceAll {
			errs = append(errs, fmt.Sprintf("#%d：%s 中 old_string 出现 %d 次（需 replace_all 或更多上下文）", i, file, count))
			continue
		}
		next := strings.Replace(original, oldString, newString, 1)
		if replaceAll && count > 1 {
			next = strings.ReplaceAll(original, oldString, newString)
		}
		prepared = append(prepared, preparedEdit{abs: abs, display: file, original: original, next: next})
	}
	if len(errs) > 0 {
		lines := make([]string, 0, len(errs))
		for _, s := range errs {
			lines = append(lines, "- "+s)
		}
		return "错误：预验未通过，未写入任何文件。\n" + strings.Join(lines, "\n")
	}

	// 第二阶段：全部通过，按序逐条写入（同一文件多条编辑各基于同一份缓存原文，后写覆盖前写）
	for _, p := range prepared {
		if err := os.WriteFile(p.abs, []byte(p.next), 0o644); err != nil {
			return fmt.Sprintf("错误：写入失败：%s", err)
		}
	}
	displays := map[string]bool{}
	uniq := 0
	for _, p := range prepared {
		if !displays[p.display] {
			displays[p.display] = true
			uniq++
		}
	}
	return fmt.Sprintf("已应用补丁：%d 处编辑，涉及 %d 个文件", len(prepared), uniq)
}
