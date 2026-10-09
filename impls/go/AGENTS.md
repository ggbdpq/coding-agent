# Notes for coding agents

gcode：coding-agent 规格的 Go 实现——终端 REPL coding agent，Go 标准库零第三方依赖（`go.mod` 无 require），自研 agent loop、SSE 解析、工具执行、权限闸门与会话持久化。包结构按五层组织：`cmd/gcode` 装配，`internal/` 下 kernel（插件注册表/App）← core（agentloop/turn/compact/trim/session/permission）← providers 与 plugins（tools/commands，`internal/plugins/plugins.go` 是唯一显式清单）← shell（repl）← cmd；依赖只能向左/向下，违反即打回，架构与依赖方向见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 常用命令

- 构建：`go build ./...`
- 测试：`go test ./...`（`internal/smoke` 是端到端冒烟：测试内 `go build` 真二进制、起本地假 SSE 服务器、子进程跑完整 REPL，明显慢于纯单测；只要快速单测时可排除它：`go test $(go list ./... | grep -v /internal/smoke)`）
- 静态检查：`golangci-lint run ./...`（v2.14.0，配置见 .golangci.yml；本机二进制在 ~/go/bin/golangci-lint）
- 格式：改动文件 `gofmt -l` 输出必须为空

## Go 规范

根级约定见 /Users/ggbdpq/cc/guahub/AGENTS.md 与 .agents/skills/golang-*（code-style、error-handling、testing、concurrency、context、lint），按需读取。测试只用标准库，不引入 testify。

## 工作纪律

- 修 bug 先写一个"把修复还原后必失败"的测试，提交说明里写它在旧代码上以什么失败。
- 交付说明固定两行：已跑 X（结果）；未跑 Y（原因）。未跑不写成通过。
- 改动行为同步更新 ARCHITECTURE.md 与相关文档；教训记 LESSONS.md（3 次重现升格为必查项）。
- 提交信息写可观察行为，一次提交一个目标。
