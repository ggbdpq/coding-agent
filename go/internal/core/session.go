// 会话持久化：JSONL 追加写，一行一条 JSON（meta 行 + message 行）。
// /resume 的语义 = 读旧文件、换新文件继续写——避免追加到可能损坏的旧文件。
// 目录边界：所有读写都限定在会话目录内，出目录一律拒绝/跳过。
package core

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"gocode/internal/kernel"
)

// SessionStore JSONL 会话存储。
type SessionStore struct {
	filePath string
	root     string // 归一化后的会话目录绝对路径
}

// NewSessionStore 打开会话目录（不存在则创建）。
func NewSessionStore(dir string) (*SessionStore, error) {
	root, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	return &SessionStore{root: root}, nil
}

// isInsideDir 目录边界校验：目标必须是本目录本身或本目录的直接/间接子路径。
func (s *SessionStore) isInsideDir(target string) bool {
	return target == s.root || strings.HasPrefix(target, s.root+string(filepath.Separator))
}

// Start 开新会话文件并写入元信息行。
func (s *SessionStore) Start(meta map[string]any) {
	// Windows 文件名禁 :，把 ISO 时间的冒号一并换掉
	name := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	name = strings.ReplaceAll(strings.ReplaceAll(name, ":", "-"), ".", "-")
	var rb [2]byte
	_, _ = rand.Read(rb[:])
	name += "-" + hex.EncodeToString(rb[:]) + ".jsonl"

	file := filepath.Join(s.root, name)
	if !s.isInsideDir(file) {
		return // 防御式自检：文件名不含分隔符，理论到不了这里
	}
	s.filePath = file
	entry := map[string]any{"type": "meta", "ts": time.Now().UnixMilli()}
	for k, v := range meta {
		entry[k] = v
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	_ = os.WriteFile(file, append(data, '\n'), 0o644)
}

// Append 追加一条消息；落盘失败静默（记会话是锦上添花，不该打断对话）。
func (s *SessionStore) Append(message kernel.ChatMessage) {
	if s.filePath == "" {
		return
	}
	data, err := json.Marshal(map[string]any{"type": "message", "message": message})
	if err != nil {
		return
	}
	f, err := os.OpenFile(s.filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(data, '\n'))
}

// ListRecent 最近 n 个会话（排除当前文件），按修改时间倒序。
func (s *SessionStore) ListRecent(n int) []kernel.SessionSummary {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil
	}
	var files []kernel.SessionSummary
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		file := filepath.Join(s.root, e.Name())
		if !s.isInsideDir(file) || file == s.filePath {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, kernel.SessionSummary{File: file, Mtime: info.ModTime().UnixMilli()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Mtime > files[j].Mtime })
	if len(files) > n {
		files = files[:n]
	}
	for i := range files {
		files[i].Label = s.readLabel(files[i].File)
	}
	return files
}

// Load 读指定会话文件的全部消息行；越出会话目录的路径一律拒绝。
func (s *SessionStore) Load(file string) []kernel.ChatMessage {
	resolved, err := filepath.Abs(file)
	if err != nil || !s.isInsideDir(resolved) {
		return nil
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return nil
	}
	var messages []kernel.ChatMessage
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var o struct {
			Type    string             `json:"type"`
			Message kernel.ChatMessage `json:"message"`
		}
		if json.Unmarshal([]byte(line), &o) == nil && o.Type == "message" && o.Message.Role != "" {
			messages = append(messages, o.Message)
		}
	}
	return messages
}

// readLabel 首条用户输入，用作列表标签（前 60 字符）。
func (s *SessionStore) readLabel(file string) string {
	if !s.isInsideDir(file) {
		return "(无用户消息)"
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return "(无用户消息)"
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var o struct {
			Type    string `json:"type"`
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(line), &o) != nil || o.Type != "message" || o.Message.Role != "user" {
			continue
		}
		text := strings.Join(strings.Fields(strings.TrimSpace(o.Message.Content)), " ")
		if text != "" {
			if utf8.RuneCountInString(text) > 60 {
				text = string([]rune(text)[:60])
			}
			return text
		}
	}
	return "(无用户消息)"
}
