// App：插件的运行环境——命令与壳通过它拿能力，彼此互不 import。
// kernel 不 import core：store 与 freshMessages 由装配方（main）注入，
// 这里只声明最小的结构化接口。
package kernel

import (
	"fmt"
	"os"
	"strings"
)

// Version 当前版本号（横幅、--version、会话 meta 三处共用）。
const Version = "0.5.0"

// AppOptions 装配选项。
type AppOptions struct {
	Yolo bool
	// FreshMessages 产出全新消息数组（system 提示词），由装配方注入（依赖 core/systemprompt）
	FreshMessages func() []ChatMessage
	Store         SessionStoreLike
}

// App 插件的运行环境。
type App struct {
	Config   *Config
	Registry *Registry
	Provider ChatClient
	Store    SessionStoreLike
	Yolo     *YoloRef
	// PlanMode 只读规划开关：开启时写类工具在 agentloop 被拒（/plan 切换）
	PlanMode *YoloRef
	// Messages 当前会话消息；命令/壳直接读写这个数组
	Messages []ChatMessage

	freshMessages func() []ChatMessage
}

// CreateApp 装配 App：选 provider → 初始化消息 → 开会话文件。
func CreateApp(config *Config, registry *Registry, opts AppOptions) (*App, error) {
	provider, err := selectProvider(config, registry)
	if err != nil {
		return nil, err
	}
	app := &App{
		Config:        config,
		Registry:      registry,
		Provider:      provider,
		Store:         opts.Store,
		Yolo:          &YoloRef{Value: opts.Yolo},
		PlanMode:      &YoloRef{Value: false},
		Messages:      nil,
		freshMessages: opts.FreshMessages,
	}
	app.ResetMessages()
	app.StartSession(nil)
	return app, nil
}

// StartSession 开新会话文件（/new、/resume 都换文件，永不追加旧文件）。
func (a *App) StartSession(extra map[string]any) {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	meta := map[string]any{
		"version": Version,
		"model":   a.Config.Model,
		"cwd":     cwd,
		"yolo":    a.Yolo.Value,
	}
	for k, v := range extra {
		meta[k] = v
	}
	a.Store.Start(meta)
}

// ResetMessages messages 换成全新 system 数组。
func (a *App) ResetMessages() { a.Messages = a.freshMessages() }

// selectProvider 显式配置的 protocol 按名选；否则按注册顺序取首个 Matches 命中的 provider。
func selectProvider(config *Config, registry *Registry) (ChatClient, error) {
	providers := registry.Providers()
	if config.Protocol != "" {
		for _, p := range providers {
			if p.Name == string(config.Protocol) {
				return p.Create(config), nil
			}
		}
		names := make([]string, 0, len(providers))
		for _, p := range providers {
			names = append(names, p.Name)
		}
		return nil, fmt.Errorf("没有名为 %s 的 provider 插件（可用：%s）", config.Protocol, strings.Join(names, ", "))
	}
	for _, p := range providers {
		if p.Matches(config.BaseURL) {
			return p.Create(config), nil
		}
	}
	return nil, fmt.Errorf("没有 provider 插件能处理 BASE_URL：%s", config.BaseURL)
}
