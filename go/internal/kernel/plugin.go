// 插件内核：四类插件的类型与注册表。
// 设计对齐 tcode：统一 Plugin 值 + kind 判别；内核只有类型与装配、没有任何行为——
// "特权核心"最小化，一切能力皆插件。
package kernel

import "fmt"

// Kind 插件类别。
type Kind string

const (
	KindTool     Kind = "tool"
	KindCommand  Kind = "command"
	KindProvider Kind = "provider"
	KindShell    Kind = "shell"
)

// ToolDef 工具插件：一个文件一个工具（core/agentloop 消费）。
type ToolDef struct {
	Name        string
	Description string
	Parameters  map[string]any // JSON Schema，直传 function calling
	// NeedsPermission 写类需要逐次确认，读类免确认
	NeedsPermission bool
	// Preview 权限确认时展示给用户看的内容
	Preview func(args map[string]any) string
	// Run 执行工具；错误一律返回 "错误：..." 文本让模型自行纠正，不 panic
	Run func(args map[string]any) string
}

// CommandOutcome 命令返回值：Exit=true 时壳收尾退出。
type CommandOutcome struct{ Exit bool }

// CommandDef 斜杠命令插件：Name 不含斜杠；输出自己打印。
type CommandDef struct {
	Name    string
	Usage   string
	Summary string
	Run     func(app *App, args []string) CommandOutcome
}

// ProviderDef 协议插件：Matches 按注册顺序首个命中的生效，兜底放清单最后。
type ProviderDef struct {
	Name    string
	Matches func(baseUrl string) bool
	Create  func(config *Config) ChatClient
}

// ShellDef 交互壳插件：REPL/TUI/单发都是并列的壳，一次只起一个。
type ShellDef struct {
	Name  string
	Start func(app *App) error
}

// Plugin 四类插件的统一外壳：恰好一个字段非 nil（kind 判别）。
// 装配清单里一值一能力，顺序即优先级（provider 的 Matches 首个命中生效）。
type Plugin struct {
	Tool     *ToolDef
	Command  *CommandDef
	Provider *ProviderDef
	Shell    *ShellDef
}

// kind 返回该插件设置的类别；没有设置任何字段时返回空串。
func (p Plugin) kind() Kind {
	switch {
	case p.Tool != nil:
		return KindTool
	case p.Command != nil:
		return KindCommand
	case p.Provider != nil:
		return KindProvider
	case p.Shell != nil:
		return KindShell
	}
	return ""
}

// name 返回该插件内部定义的名字。
func (p Plugin) name() string {
	switch {
	case p.Tool != nil:
		return p.Tool.Name
	case p.Command != nil:
		return p.Command.Name
	case p.Provider != nil:
		return p.Provider.Name
	case p.Shell != nil:
		return p.Shell.Name
	}
	return ""
}

// Registry 插件按 kind 存取；装配顺序即优先级（provider 的 Matches 首个命中生效）。
type Registry struct {
	plugins []Plugin
}

// NewRegistry 创建空注册表。
func NewRegistry() *Registry { return &Registry{} }

// Register 注册一个插件；同 kind 重名或四类字段一个都没设时报错。
func (r *Registry) Register(p Plugin) error {
	if p.kind() == "" {
		return fmt.Errorf("插件必须恰好设置 Tool/Command/Provider/Shell 之一")
	}
	for _, q := range r.plugins {
		if q.kind() == p.kind() && q.name() == p.name() {
			return fmt.Errorf("插件重名：%s/%s", p.kind(), p.name())
		}
	}
	r.plugins = append(r.plugins, p)
	return nil
}

// MustRegister 批量注册，出错即 panic——内置清单是静态的，装配错误应尽早暴露。
func (r *Registry) MustRegister(plugins ...Plugin) *Registry {
	for _, p := range plugins {
		if err := r.Register(p); err != nil {
			panic(err)
		}
	}
	return r
}

// Tools 按注册顺序返回全部工具插件。
func (r *Registry) Tools() []*ToolDef {
	out := make([]*ToolDef, 0, len(r.plugins))
	for _, p := range r.plugins {
		if p.Tool != nil {
			out = append(out, p.Tool)
		}
	}
	return out
}

// Providers 按注册顺序返回全部协议插件。
func (r *Registry) Providers() []*ProviderDef {
	out := make([]*ProviderDef, 0, len(r.plugins))
	for _, p := range r.plugins {
		if p.Provider != nil {
			out = append(out, p.Provider)
		}
	}
	return out
}

// Commands 按注册顺序返回全部命令插件。
func (r *Registry) Commands() []*CommandDef {
	out := make([]*CommandDef, 0, len(r.plugins))
	for _, p := range r.plugins {
		if p.Command != nil {
			out = append(out, p.Command)
		}
	}
	return out
}

// Shell 按名字找壳插件；找不到返回 nil。
func (r *Registry) Shell(name string) *ShellDef {
	for _, p := range r.plugins {
		if p.Shell != nil && p.Shell.Name == name {
			return p.Shell
		}
	}
	return nil
}

// ToolSchemas 工具清单 → function calling 的 tools 参数。
func (r *Registry) ToolSchemas() []ToolSchema { return ToolSchemas(r.Tools()) }

// ToolSchemas 独立导出：core/agentloop 拿到的是裸工具数组，不经注册表实例。
func ToolSchemas(tools []*ToolDef) []ToolSchema {
	schemas := make([]ToolSchema, 0, len(tools))
	for _, t := range tools {
		schemas = append(schemas, ToolSchema{
			Type: "function",
			Function: ToolSchemaFunction{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  t.Parameters,
			},
		})
	}
	return schemas
}
