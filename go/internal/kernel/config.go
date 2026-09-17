// 配置加载：环境变量 > ~/.gocode/config.json > 报错指路。
// 刻意不写死任何默认端点/模型——本地优先工具，用户自己决定请求发去哪。
// 协议选择不走这里：protocol 只有显式配置时才非空，自动识别由 provider 插件的 Matches 做。
package kernel

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config 装配所需的全部配置。
type Config struct {
	APIKey  string
	BaseURL string
	Model   string
	// Protocol 仅显式配置（GOCODE_PROTOCOL / config.json）时非空；否则由 provider 插件按 URL 自动识别
	Protocol     Protocol
	ContextLimit int    // 估算 token 上限，超过即触发上下文裁剪
	GocodeDir    string // ~/.gocode 目录，配置/会话/全局指令都住这里
}

// fileConfig ~/.gocode/config.json 的形状（与 tcode 完全一致）。
type fileConfig struct {
	APIKey   string `json:"apiKey"`
	BaseURL  string `json:"baseUrl"`
	Model    string `json:"model"`
	Protocol string `json:"protocol"`
}

func readJSONConfig(dir string) (fileConfig, error) {
	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return fileConfig{}, nil
		}
		return fileConfig{}, fmt.Errorf("~/.gocode/config.json 读取失败：%w", err)
	}
	var fc fileConfig
	if err := json.Unmarshal(data, &fc); err != nil {
		return fileConfig{}, fmt.Errorf("~/.gocode/config.json 解析失败：%w", err)
	}
	return fc, nil
}

// LoadConfig 按优先级（环境变量 > 配置文件）加载配置；缺关键项时报中文指路。
func LoadConfig() (*Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("找不到用户主目录：%w", err)
	}
	dir := filepath.Join(home, ".gocode")
	fc, err := readJSONConfig(dir)
	if err != nil {
		return nil, err
	}

	apiKey := firstNonEmpty(os.Getenv("GOCODE_API_KEY"), fc.APIKey)
	baseURL := strings.TrimRight(firstNonEmpty(os.Getenv("GOCODE_BASE_URL"), fc.BaseURL), "/")
	model := firstNonEmpty(os.Getenv("GOCODE_MODEL"), fc.Model)
	contextLimit := 100_000
	if n, err := strconv.Atoi(os.Getenv("GOCODE_CONTEXT_LIMIT")); err == nil && n != 0 {
		contextLimit = n
	}

	var protocol Protocol
	raw := strings.ToLower(firstNonEmpty(os.Getenv("GOCODE_PROTOCOL"), fc.Protocol))
	if raw != "" {
		if raw != string(ProtocolOpenAI) && raw != string(ProtocolAnthropic) {
			return nil, fmt.Errorf("GOCODE_PROTOCOL 只能是 openai 或 anthropic，收到：%s", raw)
		}
		protocol = Protocol(raw)
	}

	var missing []string
	for _, kv := range [][2]string{
		{"GOCODE_API_KEY", apiKey},
		{"GOCODE_BASE_URL", baseURL},
		{"GOCODE_MODEL", model},
	} {
		if kv[1] == "" {
			missing = append(missing, kv[0])
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf(
			"缺少模型配置：%s。\n"+
				"设置方式（二选一）：\n"+
				"  1. 环境变量：export GOCODE_API_KEY=sk-xxx GOCODE_BASE_URL=https://xxx/v1 GOCODE_MODEL=模型名\n"+
				"  2. 配置文件：~/.gocode/config.json 写 {\"apiKey\":\"...\",\"baseUrl\":\"...\",\"model\":\"...\"}\n"+
				"任何 OpenAI 兼容端点都可以（本地中转、云 API 均可）。", strings.Join(missing, "、"))
	}
	return &Config{APIKey: apiKey, BaseURL: baseURL, Model: model, Protocol: protocol, ContextLimit: contextLimit, GocodeDir: dir}, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
