// Package smoke 端到端冒烟：起本地假 SSE 服务器 + 真 gcode 子进程，验证全链路。
// 无网络依赖：所有模型请求都落在 127.0.0.1 的假服务器上。
package smoke
