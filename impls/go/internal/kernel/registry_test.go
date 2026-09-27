// 内核注册表单测：锁死按类取用、重名拒绝、schema 形状（对齐 tcode/test/registry.test.ts）。
package kernel

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

type fakeClient struct{}

func (fakeClient) Chat(context.Context, []ChatMessage, ChatOptions) (CompletionResult, error) {
	return CompletionResult{Message: ChatMessage{Role: "assistant"}}, nil
}

var fakeTool = &ToolDef{
	Name:            "t1",
	Description:     "测试工具",
	Parameters:      map[string]any{"type": "object", "properties": map[string]any{}},
	NeedsPermission: false,
	Preview:         func(map[string]any) string { return "" },
	Run:             func(context.Context, map[string]any) string { return "ok" },
}

var fakeProvider = &ProviderDef{
	Name:    "fake",
	Matches: func(string) bool { return true },
	Create:  func(*Config) ChatClient { return fakeClient{} },
}

var fakeCommand = &CommandDef{
	Name: "cmd1", Usage: "/cmd1", Summary: "测试命令",
	Run: func(*App, []string) CommandOutcome { return CommandOutcome{} },
}

var fakeShell = &ShellDef{Name: "repl", Start: func(*App) error { return nil }}

func TestRegistryRegisterAndQuery(t *testing.T) {
	r := NewRegistry().MustRegister(
		Plugin{Tool: fakeTool},
		Plugin{Provider: fakeProvider},
		Plugin{Command: fakeCommand},
		Plugin{Shell: fakeShell},
	)
	if len(r.Tools()) != 1 || r.Tools()[0].Name != "t1" {
		t.Fatalf("tools 取用异常：%v", r.Tools())
	}
	if len(r.Providers()) != 1 || r.Providers()[0].Name != "fake" {
		t.Fatalf("providers 取用异常：%v", r.Providers())
	}
	if len(r.Commands()) != 1 || r.Commands()[0].Name != "cmd1" {
		t.Fatalf("commands 取用异常：%v", r.Commands())
	}
	if sh := r.Shell("repl"); sh == nil || sh.Name != "repl" {
		t.Fatalf("shell(repl) 取用异常：%v", sh)
	}
	if r.Shell("不存在") != nil {
		t.Fatalf("不存在的 shell 应返回 nil")
	}
}

func TestRegistryDuplicateName(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(Plugin{Tool: fakeTool}); err != nil {
		t.Fatalf("首次注册不应报错：%v", err)
	}
	err := r.Register(Plugin{Tool: &ToolDef{Name: "t1"}})
	if err == nil || !strings.Contains(err.Error(), "插件重名") {
		t.Fatalf("同 kind 重名应拒绝，got %v", err)
	}
	// 跨 kind 同名允许
	if err := r.Register(Plugin{Command: &CommandDef{Name: "t1"}}); err != nil {
		t.Fatalf("跨 kind 同名应允许：%v", err)
	}
}

func TestRegistryRejectsEmptyPlugin(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(Plugin{}); err == nil {
		t.Fatalf("空插件应被拒绝")
	}
}

func TestRegistryToolSchemas(t *testing.T) {
	r := NewRegistry().MustRegister(Plugin{Tool: fakeTool})
	schemas := r.ToolSchemas()
	want := []ToolSchema{{
		Type: "function",
		Function: ToolSchemaFunction{
			Name:        "t1",
			Description: "测试工具",
			Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
		},
	}}
	if !reflect.DeepEqual(schemas, want) {
		t.Fatalf("schema 形状不符：\n got %+v\nwant %+v", schemas, want)
	}
}

func TestRegistryPreservesRegistrationOrder(t *testing.T) {
	r := NewRegistry().MustRegister(
		Plugin{Tool: fakeTool},
		Plugin{Tool: &ToolDef{Name: "t2"}},
	)
	got := make([]string, 0, len(r.Tools()))
	for _, tool := range r.Tools() {
		got = append(got, tool.Name)
	}
	if !reflect.DeepEqual(got, []string{"t1", "t2"}) {
		t.Fatalf("注册顺序应保持（装配顺序即优先级），got %v", got)
	}
}
