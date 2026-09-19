// @文件引用（v0.4-2）：把输入里的 @path 注入对应文件内容。
// ExpandAtRefs 是纯函数（读文件经参数注入，方便单测）；只读不写，无需权限闸门。
// 路径含空格不支持（@token 以空白分隔）；@目录 不展开——需要时升级。
package core

import (
	"fmt"
	"io"
	"os"
	"regexp"
)

// MaxAtRefChars 单个 @引用 注入内容的字符上限（256KB）。
const MaxAtRefChars = 256 * 1024

// maxReadBytes 生产读文件的字节上限（1MB 内全读，超出截断）。
const maxReadBytes = 1024 * 1024

// atRefRe 行首或空白后的 @token（token 本身不含空白与 @）。
var atRefRe = regexp.MustCompile(`(^|\s)@([^\s@]+)`)

// ExpandAtRefs 把 line 里的 @path 替换为文件内容块；读不到的 token 原样保留并标注
// "（文件不存在）"，超长内容截断。REPL 与 exec 共用。
func ExpandAtRefs(line string, readFile func(path string) (string, bool)) string {
	return atRefRe.ReplaceAllStringFunc(line, func(match string) string {
		sub := atRefRe.FindStringSubmatch(match)
		lead, rawPath := sub[1], sub[2]
		content, ok := readFile(rawPath)
		if !ok {
			return lead + "@" + rawPath + "（文件不存在）"
		}
		body := content
		if runes := []rune(content); len(runes) > MaxAtRefChars {
			body = fmt.Sprintf("%s\n…（已截断，原文 %d 字符）", string(runes[:MaxAtRefChars]), len(runes))
		}
		return lead + "[引用文件 " + rawPath + "]\n" + body + "\n[/引用文件]"
	})
}

// ReadCapped 生产环境的 @引用 读文件：目录/不可读返回 ok=false；内容封顶 1MB。
func ReadCapped(p string) (string, bool) {
	f, err := os.Open(p)
	if err != nil {
		return "", false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		return "", false
	}
	data, err := io.ReadAll(io.LimitReader(f, maxReadBytes))
	if err != nil {
		return "", false
	}
	return string(data), true
}
