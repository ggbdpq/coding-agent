# vibe/agent-code · 同一 coding agent 的多语言实现

五个目录是**同一份行为规格**的五种语言表达。规格准绳是
[tcode](tcode/)（TypeScript 版，功能最全：REPL + web 壳 + Tauri 桌面版）；
其余实现逐条对齐，已知差异只有两条：无 web 壳；同步语言（pcode/gcode/rcode）
轮中 Ctrl+C 退出进程——**ccode 是唯一例外**（CancellationToken 完整移植三态真取消）。

设计决策与对照分析：[tcode/docs/notes/2026-09-18-three-languages.md](tcode/docs/notes/2026-09-18-three-languages.md)。

## 族谱

| 项目 | 语言 | 直接依赖 | 入口 | 测试 | 真机 | 学习指南 |
| --- | --- | --- | --- | --- | --- | --- |
| [tcode](tcode/) | TypeScript / Node 24 | 0 | `node bin/tcode.js`（`web` 子命令；Bun 1.4 兼容实测） | `npm test` + `npm run smoke`（6 场景） | ✅ | [docs/guides/项目改名与身份迁移.md](tcode/docs/guides/项目改名与身份迁移.md) |
| [pcode](pcode/) | Python ≥3.12 | 0 | `python -m pcode` | `python -m unittest discover -s test` + `python test/smoke.py`（5 场景） | ✅ | [docs/guides/学习指南.md](pcode/docs/guides/学习指南.md) |
| [gcode](gcode/) | Go 1.26 | 0 | `go run ./cmd/gcode` | `go test ./...`（含冒烟） | ✅ | [docs/guides/学习指南.md](gcode/docs/guides/学习指南.md) |
| [rcode](rcode/) | Rust（serde_json + ureq） | 2 | `cargo run` | `cargo test`（含冒烟） | ✅ | [docs/guides/学习指南.md](rcode/docs/guides/学习指南.md) |
| [ccode](ccode/) | C# / .NET 8 | 0 | `dotnet run` | `dotnet run --project tests`（33 项，含冒烟） | ✅ | [docs/guides/学习指南.md](ccode/docs/guides/学习指南.md)（主题=可取消性） |

## 共同约定

- 行为规格：八工具（read/write/edit/bash/glob/grep/todo/web_fetch，web_fetch 带 SSRF
  三道闸）、权限三态闸门（allow/deny/always，写类逐次确认，`--yolo` 免确认）、
  40 轮熔断、上下文裁剪、指数退避重试、双协议（OpenAI 兼容 + Anthropic，后者按
  BASE_URL 含 `/anthropic` 自动识别）。
- 配置目录各自独立：`~/.tcode`、`~/.pcode`、`~/.gcode`、`~/.rcode`、`~/.ccode`
  （config.json / sessions/ / AGENTS.md）；会话 JSONL 的 schema 五版通用。
- 历史 bundle：`tcode-history.bundle`（`git clone` 即可还原）。
- 修 bug 请对照笔记查其余版本的对应模块——一份修，五份同步。
