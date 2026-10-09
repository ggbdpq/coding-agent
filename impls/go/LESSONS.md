# Lessons

规则长自真实失败：每条教训 = 规则 + 为什么 + 证据（文件/commit/复现方式）+ Seen N×。
同一条教训在 3 个不同日期重现，升格为 AGENTS.md 必查项。
从第一条真实教训开始记，不预写占位条目。

## 活跃教训

### 2026-10-10 网页正文读取中断不能当成功（Seen 1×）

- 规则：`web_fetch` 必须检查 `io.ReadAll` 错误；读取中断时返回既有 `错误：...` 格式，不把部分正文交给模型。
- 为什么：`io.ReadAll` 可以同时返回已读字节与错误，丢弃错误会把截断内容标成 `HTTP 200` 成功响应。
- 证据：`internal/plugins/tools/webfetch.go`；运行 `go test ./internal/plugins/tools -run '^TestWebFetchReadFailure$' -count=1`，旧代码的 `interrupted_body` 打印 `web_fetch = "HTTP 200 · text/plain · http://8.8.8.8/docs\n\npartial"，want "错误：读取失败：unexpected EOF"`，修复后通过。

### 2026-10-10 DNS 守卫返回错误时保留原因链（Seen 1×）

- 规则：`AssertResolvesPublic` 包装解析错误使用 `%w`，让 Go 调用方继续检查 `*net.DNSError`。
- 为什么：`%s` 只留下文字，原来可判断的原因类型被丢失；`%w` 保持展示文本并保留错误链。
- 证据：`internal/plugins/tools/netguard.go`；`go test ./internal/plugins/tools -run '^TestAssertResolvesPublicPreservesDNSError$' -count=1` 在旧代码的两个命名子测试均打印 `解析错误应保留 *net.DNSError，got *errors.errorString`，修复后通过。

## 冒烟输出采集的读写必须共用锁（2026-10-10，Seen 1×）

- 规则：stdout/stderr 的 `io.Copy` 写入与输出快照读取必须通过同一把锁；锁覆盖一个 Write，不覆盖整段 Copy。
- 为什么：只给读取加锁不能保护 `strings.Builder`，整段 Copy 持锁又会让流式轮询等到管道关闭。
- 证据：`internal/smoke/smoke_test.go`，`go test -race ./internal/smoke -run '^TestSmokeOutputWhilePolling$' -count=1`；旧采集器打印 `WARNING: DATA RACE` 与 `race detected during execution of test`。
