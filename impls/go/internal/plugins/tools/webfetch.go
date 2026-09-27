// web_fetch 工具：抓取公网页面文本，供模型查文档/API 说明。
// 安全三道闸（实现即验收条件）：仅 http/https；字面与 DNS 双重拒绝私有/保留地址；
// 重定向不自动跟随——每跳重新过守卫，杜绝"公网 302 跳内网"。
// 取消：ctx 贯穿每一跳（用户中止即断请求）。
package tools

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"gcode/internal/kernel"
)

const (
	fetchMaxBytes  = 512 * 1024
	fetchMaxChars  = 8000
	fetchRedirects = 5
	fetchTimeout   = 20 * time.Second
)

// fetchClient 手动跟随重定向：每一跳都重新过守卫。
var fetchClient = &http.Client{
	Timeout: fetchTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

var (
	reScriptTag = regexp.MustCompile(`(?is)<script[\s\S]*?</script>`)
	reStyleTag  = regexp.MustCompile(`(?is)<style[\s\S]*?</style>`)
	reAnyTag    = regexp.MustCompile(`(?s)<[^>]+>`)
	reSpaces    = regexp.MustCompile(`[ \t]+`)
	reNewlines  = regexp.MustCompile(`\n{3,}`)
)

// htmlToText 极简 HTML→文本：去 script/style 与标签。不做实体全解码，够模型读即可。
func htmlToText(html string) string {
	html = reScriptTag.ReplaceAllString(html, " ")
	html = reStyleTag.ReplaceAllString(html, " ")
	html = reAnyTag.ReplaceAllString(html, " ")
	html = reSpaces.ReplaceAllString(html, " ")
	html = reNewlines.ReplaceAllString(html, "\n\n")
	return strings.TrimSpace(html)
}

// NewWebFetch 构造 web_fetch 工具插件。
func NewWebFetch() *kernel.ToolDef {
	return &kernel.ToolDef{
		Name:        "web_fetch",
		Description: "抓取一个公网 URL 的页面文本（仅 http/https）。用于查阅文档、API 说明、报错线索；内网/私有地址会被拒绝。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url":       map[string]any{"type": "string", "description": "完整的 http(s) URL"},
				"max_chars": map[string]any{"type": "number", "description": fmt.Sprintf("返回正文最大字符数，默认 %d", fetchMaxChars)},
			},
			"required": []string{"url"},
		},
		NeedsPermission: true,
		Preview: func(args map[string]any) string {
			return fmt.Sprintf("GET %s（出站网络请求）", argString(args, "url"))
		},
		Run: func(ctx context.Context, args map[string]any) string { return runWebFetch(ctx, args) },
	}
}

func runWebFetch(ctx context.Context, args map[string]any) string {
	raw := argString(args, "url")
	check := CheckURLLiteral(raw)
	if !check.OK {
		return check.Reason
	}
	current := check.URL

	var resp *http.Response
	for hop := 0; hop <= fetchRedirects; hop++ {
		if hc := CheckURLLiteral(current.String()); !hc.OK {
			return hc.Reason
		}
		if err := AssertResolvesPublic(current.Hostname()); err != nil {
			return err.Error()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, current.String(), nil)
		if err != nil {
			return fmt.Sprintf("错误：构造请求失败：%s", err)
		}
		r, err := fetchClient.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return "错误：已中止（用户取消）"
			}
			return fmt.Sprintf("错误：请求失败：%s", err)
		}
		resp = r
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			loc := resp.Header.Get("Location")
			if loc == "" {
				break
			}
			next, perr := current.Parse(loc)
			if perr != nil {
				break
			}
			current = next
			resp.Body.Close()
			continue
		}
		break
	}
	if resp == nil {
		return "错误：请求未发出"
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Sprintf("错误：HTTP %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}

	ctype := resp.Header.Get("Content-Type")
	data, _ := io.ReadAll(io.LimitReader(resp.Body, fetchMaxBytes))
	body := string(data)
	text := body
	if strings.Contains(strings.ToLower(ctype), "html") {
		text = htmlToText(body)
	}
	maxChars := int(argNumber(args, "max_chars", fetchMaxChars))
	if maxChars < 200 {
		maxChars = 200
	}
	runes := []rune(text)
	out := text
	note := ""
	if len(runes) > maxChars {
		out = string(runes[:maxChars])
		note = fmt.Sprintf("\n…（已截断，原文 %d 字符，可用 max_chars 调大）", len(runes))
	}
	displayType := ctype
	if displayType == "" {
		displayType = "未知类型"
	}
	return fmt.Sprintf("HTTP %d · %s · %s\n\n%s%s", resp.StatusCode, displayType, current.String(), out, note)
}
