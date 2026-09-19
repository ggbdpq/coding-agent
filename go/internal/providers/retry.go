// 重试纪律：两种协议客户端共用。仅首字节前可重试（流已开始的中断不重试，避免内容重复）。
package providers

import (
	"context"
	"errors"
	"net"
	"time"

	"gcode/internal/kernel"
)

// RetryableError 标记可重试的错误（HTTP 429/5xx/529、网络层失败）。
type RetryableError struct{ msg string }

func (e *RetryableError) Error() string { return e.msg }

// WithRetry 最多 3 次尝试，指数退避 1s/2s；
// context 取消/超时（用户中止）绝不重试；不可重试错误立即返回。
func WithRetry(ctx context.Context, run func() (kernel.CompletionResult, error)) (kernel.CompletionResult, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return kernel.CompletionResult{}, err
		}
		res, err := run()
		if err == nil {
			return res, nil
		}
		// 用户中止绝不重试：ctx 已取消，或错误链里带着取消/超时
		if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return res, err
		}
		var re *RetryableError
		var ne net.Error
		if !errors.As(err, &re) && !errors.As(err, &ne) {
			return res, err
		}
		if attempt == 2 {
			return res, err
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return kernel.CompletionResult{}, ctx.Err()
		case <-time.After(time.Second << attempt): // 1s, 2s
		}
	}
	return kernel.CompletionResult{}, lastErr
}
