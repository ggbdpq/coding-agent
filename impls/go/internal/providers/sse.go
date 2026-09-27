// SSE 共用件：从响应体流中逐块产出 data 字段内容，OpenAI 与 Anthropic 两种协议通用。
// ctx 取消时停止产出（底层请求被取消后读循环也会随之出错收尾）。
package providers

import (
	"bufio"
	"context"
	"io"
	"iter"
	"strings"
)

// SSEData 按 SSE 事件边界（空行）产出 data 字段内容；消费方 break 即停止读取并释放底层流。
func SSEData(ctx context.Context, r io.Reader) iter.Seq[string] {
	return func(yield func(string) bool) {
		br := bufio.NewReader(r)
		var lines []string
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			line, err := br.ReadString('\n')
			trimmed := strings.TrimRight(line, "\r\n")
			if trimmed == "" {
				if len(lines) > 0 {
					data := strings.Join(lines, "\n")
					lines = lines[:0]
					if !yield(data) {
						return
					}
				}
			} else if strings.HasPrefix(trimmed, "data:") {
				if v := strings.TrimSpace(trimmed[len("data:"):]); v != "" {
					lines = append(lines, v)
				}
			}
			if err != nil {
				// EOF 或读错误：残留半事件也收尾
				if len(lines) > 0 {
					yield(strings.Join(lines, "\n"))
				}
				return
			}
		}
	}
}
