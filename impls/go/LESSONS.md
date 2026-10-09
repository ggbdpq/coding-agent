# Lessons

规则长自真实失败：每条教训 = 规则 + 为什么 + 证据（文件/commit/复现方式）+ Seen N×。
同一条教训在 3 个不同日期重现，升格为 AGENTS.md 必查项。
从第一条真实教训开始记，不预写占位条目。

## 活跃教训

### 2026-10-10 网页正文读取中断不能当成功（Seen 1×）

- 规则：`web_fetch` 必须检查 `io.ReadAll` 错误；读取中断时返回既有 `错误：...` 格式，不把部分正文交给模型。
- 为什么：`io.ReadAll` 可以同时返回已读字节与错误，丢弃错误会把截断内容标成 `HTTP 200` 成功响应。
- 证据：`internal/plugins/tools/webfetch.go`；运行 `go test ./internal/plugins/tools -run '^TestWebFetchReadFailure$' -count=1`，旧代码的 `interrupted_body` 打印 `web_fetch = "HTTP 200 · text/plain · http://8.8.8.8/docs\n\npartial"，want "错误：读取失败：unexpected EOF"`，修复后通过。
