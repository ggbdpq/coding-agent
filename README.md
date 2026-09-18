# vibe/agent-code · 同一 coding agent 的多语言实现

五个目录是**同一份行为规格**的五种语言表达，已全部升级至 **v0.3.0**（统一事件模型 +
取消贯穿 + /compact 上下文压缩）。规格准绳是 [tcode](tcode/)（TypeScript 版，功能最全：
REPL + web 壳 + Tauri 桌面版）；其余实现逐条对齐，已知差异只有两条：无 web 壳；
同步语言（pcode/rcode）轮中 Ctrl+C 退出进程——**gcode 与 ccode 支持轮中真取消**
（gcode 用 signal.NotifyContext，ccode 用 CancellationToken）。

设计决策与对照分析：[tcode/docs/notes/2026-09-18-three-languages.md](tcode/docs/notes/2026-09-18-three-languages.md)。
开发计划（从零到一 / 从一到一百 / 新建语言版操作手册）：[docs/从零到一到一百.md](docs/从零到一到一百.md)。

## 族谱

| 项目 | 语言 | 直接依赖 | 入口 | 测试 | 真机 | 学习指南 |
| --- | --- | --- | --- | --- | --- | --- |
| [tcode](tcode/) | TypeScript / Node 24 | 0 | `node bin/tcode.js`（`web` 子命令；Bun 1.4 兼容实测） | `npm test` + `npm run smoke`（6 场景） | ✅ | [项目改名与身份迁移](tcode/docs/guides/项目改名与身份迁移.md)、[v0.3 事件与可取消](tcode/docs/guides/v03-事件模型与可取消性.md) |
| [pcode](pcode/) | Python ≥3.12 | 0 | `python -m pcode` | `python -m unittest discover -s test` + `python test/smoke.py`（5 场景） | ✅ | [学习指南](pcode/docs/guides/学习指南.md)、[事件与压缩](pcode/docs/guides/事件与压缩.md) |
| [gcode](gcode/) | Go 1.26 | 0 | `go run ./cmd/gcode` | `go test ./...`（含冒烟 6 场景） | ✅ | [学习指南](gcode/docs/guides/学习指南.md)、[事件与取消](gcode/docs/guides/事件与取消.md) |
| [rcode](rcode/) | Rust（serde_json + ureq） | 2 | `cargo run` | `cargo test`（含冒烟） | ✅ | [学习指南](rcode/docs/guides/学习指南.md)、[事件与压缩](rcode/docs/guides/事件与压缩.md) |
| [ccode](ccode/) | C# / .NET 8 | 0 | `dotnet run` | `dotnet run --project tests`（41 项，含冒烟） | ✅ | [学习指南](ccode/docs/guides/学习指南.md)（主题=可取消性）、[事件与压缩](ccode/docs/guides/事件与压缩.md) |

## 共同约定（v0.3）

- 行为规格：八工具（read/write/edit/bash/glob/grep/todo/web_fetch，web_fetch 带 SSRF
  三道闸）、权限三态闸门（allow/deny/always，写类逐次确认）、40 轮熔断、双协议
  （OpenAI 兼容 + Anthropic，按 BASE_URL 含 `/anthropic` 自动识别）。
- **统一事件模型**：AgentEvent（turn_start/user/text_delta/tool_call/tool_result/
  trimmed/turn_end+终态原因），turn 唯一生产者，壳只订阅渲染。
- **上下文治理**：轮前估算超限先 /compact 摘要压缩（保留任务目标），失败退裁剪
  （丢最旧工具输出，保留最近 12 条）。
- 配置目录各自独立：`~/.tcode`、`~/.pcode`、`~/.gcode`、`~/.rcode`、`~/.ccode`
  （config.json / sessions/ / AGENTS.md）；会话 JSONL 的 schema 五版通用。
- 历史 bundle：`tcode-history.bundle`（`git clone` 即可还原）。
- 修 bug 请对照笔记查其余版本的对应模块——一份修，五份同步。
