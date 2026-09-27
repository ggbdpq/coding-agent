// 配置加载：环境变量 > ~/.gcode/config.json > 报错指路。
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
	// Protocol 仅显式配置（GCODE_PROTOCOL / config.json）时非空；否则由 provider 插件按 URL 自动识别
	Protocol Protocol
	// Approval 审批策略（R4）：normal=写类逐次确认（默认）；never=全部免确认（--yolo 等价）。
	// Codex 式 untrusted/on-failure 依赖 OS 沙箱，明确不做。
	Approval string
	// AllowWriteDirs 写白名单（R4）：位于这些目录内的 write/edit 免确认（已 filepath.Abs 归一化）。
	// bash/web_fetch 不受白名单影响（命令级操作无法按路径约束），仍逐次确认。
	AllowWriteDirs []string
	ContextLimit   int    // 估算 token 上限，超过即触发上下文裁剪
	GocodeDir      string // ~/.gcode 目录，配置/会话/全局指令都住这里
}

// fileConfig ~/.gcode/config.json 的形状（与 tcode 完全一致）。
type fileConfig struct {
	APIKey         string   `json:"apiKey"`
	BaseURL        string   `json:"baseUrl"`
	Model          string   `json:"model"`
	Protocol       string   `json:"protocol"`
	Approval       string   `json:"approval"`
	AllowWriteDirs []string `json:"allowWriteDirs"`
}

func readJSONConfig(dir string) (fileConfig, error) {
	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return fileConfig{}, nil
		}
		return fileConfig{}, fmt.Errorf("~/.gcode/config.json 读取失败：%w", err)
	}
	var fc fileConfig
	if err := json.Unmarshal(data, &fc); err != nil {
		return fileConfig{}, fmt.Errorf("~/.gcode/config.json 解析失败：%w", err)
	}
	return fc, nil
}

// LoadConfig 按优先级（环境变量 > 配置文件）加载配置；缺关键项时报中文指路。
func LoadConfig() (*Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("找不到用户主目录：%w", err)
	}
	dir := filepath.Join(home, ".gcode")
	fc, err := readJSONConfig(dir)
	if err != nil {
		return nil, err
	}

	apiKey := firstNonEmpty(os.Getenv("GCODE_API_KEY"), fc.APIKey)
	baseURL := strings.TrimRight(firstNonEmpty(os.Getenv("GCODE_BASE_URL"), fc.BaseURL), "/")
	model := firstNonEmpty(os.Getenv("GCODE_MODEL"), fc.Model)
	contextLimit := 100_000
	if n, err := strconv.Atoi(os.Getenv("GCODE_CONTEXT_LIMIT")); err == nil && n != 0 {
		contextLimit = n
	}

	var protocol Protocol
	raw := strings.ToLower(firstNonEmpty(os.Getenv("GCODE_PROTOCOL"), fc.Protocol))
	if raw != "" {
		if raw != string(ProtocolOpenAI) && raw != string(ProtocolAnthropic) {
			return nil, fmt.Errorf("GCODE_PROTOCOL 只能是 openai 或 anthropic，收到：%s", raw)
		}
		protocol = Protocol(raw)
	}

	// 审批策略（R4）：环境变量 > config.json；只认 normal/never，默认 normal 逐次确认
	approval := strings.ToLower(firstNonEmpty(os.Getenv("GCODE_APPROVAL"), fc.Approval))
	if approval == "" {
		approval = "normal"
	}
	if approval != "normal" && approval != "never" {
		return nil, fmt.Errorf("GCODE_APPROVAL 只能是 normal 或 never，收到：%s", approval)
	}

	// 写白名单（R4）：config.json allowWriteDirs 优先，否则环境变量 GCODE_ALLOW_WRITE
	//（按 os.PathListSeparator 分隔）；全部 filepath.Abs 归一化，空段跳过（不误收 cwd）
	var rawDirs []string
	if len(fc.AllowWriteDirs) > 0 {
		rawDirs = fc.AllowWriteDirs
	} else if env := os.Getenv("GCODE_ALLOW_WRITE"); env != "" {
		rawDirs = strings.Split(env, string(os.PathListSeparator))
	}
	var allowWriteDirs []string
	for _, d := range rawDirs {
		if d == "" {
			continue
		}
		abs, err := filepath.Abs(d)
		if err != nil {
			continue
		}
		allowWriteDirs = append(allowWriteDirs, abs)
	}

	var missing []string
	for _, kv := range [][2]string{
		{"GCODE_API_KEY", apiKey},
		{"GCODE_BASE_URL", baseURL},
		{"GCODE_MODEL", model},
	} {
		if kv[1] == "" {
			missing = append(missing, kv[0])
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf(
			"缺少模型配置：%s。\n"+
				"设置方式（二选一）：\n"+
				"  1. 环境变量：export GCODE_API_KEY=sk-xxx GCODE_BASE_URL=https://xxx/v1 GCODE_MODEL=模型名\n"+
				"  2. 配置文件：~/.gcode/config.json 写 {\"apiKey\":\"...\",\"baseUrl\":\"...\",\"model\":\"...\"}\n"+
				"任何 OpenAI 兼容端点都可以（本地中转、云 API 均可）。", strings.Join(missing, "、"))
	}
	return &Config{
		APIKey:         apiKey,
		BaseURL:        baseURL,
		Model:          model,
		Protocol:       protocol,
		Approval:       approval,
		AllowWriteDirs: allowWriteDirs,
		ContextLimit:   contextLimit,
		GocodeDir:      dir,
	}, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
