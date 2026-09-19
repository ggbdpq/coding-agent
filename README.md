# vibe/labs/coding-agent · 同一 coding agent 的多语言实现

五个语言目录是**同一份行为规格**的五种语言表达，全部对齐至 **v0.5.0** 能力线
（Plan Mode / apply_patch 原子补丁 / diff 预览 / Skill 索引）。规格准绳是
[typescript](typescript/)（tcode，TypeScript 版，功能最全：REPL + web 壳 + Tauri 桌面版）；
其余实现逐条对齐，已知差异只有两条：无 web 壳；同步语言（python/rust）轮中 Ctrl+C
退出进程——**go 与 csharp 支持轮中真取消**（go 用 signal.NotifyContext，csharp 用
CancellationToken）。

> 目录命名映射（2026-09-19 语言目录化）：typescript/python/go/rust/csharp ←
> tcode/pcode/gcode/rcode/ccode。**项目身份名不变**：入口（`node bin/tcode.js`、
> `python -m pcode`、`go run ./cmd/gcode`、`cargo run`、`dotnet run`）、环境变量
> 前缀（TCODE_* 等）、配置目录（~/.tcode 等）、会话 JSONL schema 均维持原名。

设计决策与对照分析：[typescript/docs/notes/2026-09-18-three-languages.md](typescript/docs/notes/2026-09-18-three-languages.md)。
开发计划（从零到一 / 从一到一百 / 新建语言版操作手册）：[docs/从零到一到一百.md](docs/从零到一到一百.md)。
跨语言设计规范骨架：[specs/](specs/)（骨架期，规格正文以各主题权威源码为准）。

## 目录结构

```text
coding-agent/
├── typescript/          # tcode —— 规格准绳（TS / Node 24）
├── python/              # pcode —— Python ≥3.12 纯标准库
├── go/                  # gcode —— Go 1.26 纯标准库
├── rust/                # rcode —— Rust（serde_json+ureq 两依赖）
├── csharp/              # ccode —— C# / .NET 8 纯内置
├── specs/               # 跨语言统一设计规范（骨架）
├── references/history/  # 并仓前独立历史 git bundle 存档
└── docs/                # 家族手册与路线图
```

## 族谱

| 项目 | 语言目录 | 直接依赖 | 入口 | 测试 | 真机 | 学习指南 |
| --- | --- | --- | --- | --- | --- | --- |
| [tcode](typescript/) | `typescript/` | 0 | `node bin/tcode.js`（`web` 子命令；Bun 1.4 兼容实测） | `npm test` + `npm run smoke`（6 场景） | ✅ | [项目改名与身份迁移](typescript/docs/guides/项目改名与身份迁移.md)、[v0.3 事件模型与可取消性](typescript/docs/guides/v03-事件模型与可取消性.md) |
| [pcode](python/) | `python/` | 0 | `python -m pcode` | `python -m unittest discover -s test` + `python test/smoke.py`（6 场景） | ✅ | [学习指南](python/docs/guides/学习指南.md)、[事件与压缩](python/docs/guides/事件与压缩.md) |
| [gcode](go/) | `go/` | 0 | `go run ./cmd/gcode` | `go test ./...`（含冒烟 6 场景） | ✅ | [学习指南](go/docs/guides/学习指南.md)、[事件与取消](go/docs/guides/事件与取消.md) |
| [rcode](rust/) | `rust/` | 2 | `cargo run` | `cargo test`（含冒烟 7 场景） | ✅ | [学习指南](rust/docs/guides/学习指南.md)、[事件与压缩](rust/docs/guides/事件与压缩.md) |
| [ccode](csharp/) | `csharp/` | 0 | `dotnet run` | `dotnet run --project tests`（62 项，含冒烟） | ✅ | [学习指南](csharp/docs/guides/学习指南.md)（主题=可取消性）、[事件与压缩](csharp/docs/guides/事件与压缩.md) |

## 共同约定（v0.5 能力线）

- 行为规格：九工具（read/write/edit/bash/glob/grep/todo/web_fetch/apply_patch，
  web_fetch 带 SSRF 三道闸）、权限三态闸门（allow/deny/always，写类逐次确认，
  `allowWriteDirs` 白名单内免确认）、40 轮熔断、双协议（OpenAI 兼容 + Anthropic，
  按 BASE_URL 含 `/anthropic` 自动识别）。
- **统一事件模型**：AgentEvent（turn_start/user/text_delta/tool_call/tool_result/
  trimmed/usage/turn_end+终态原因），turn 唯一生产者，壳只订阅渲染。
- **上下文治理**：估算超预算 80% 先 /compact 摘要压缩（保留最近 4 条原文），
  仍超限退裁剪（丢最旧工具输出，保留最近 12 条）。
- **Plan Mode**：`/plan` 切换只读规划，写类工具在权限闸门之前被拒并引导产出计划。
- **无交互模式**：`tcode exec "任务"`（须 --yolo），退出码携带成败；@文件引用
  （缺失标注/256KB 截断）。
- **审批策略**：`--approval`/`<X>_APPROVAL` normal|never（never 等价 --yolo）。
- 配置目录各自独立：`~/.tcode`、`~/.pcode`、`~/.gcode`、`~/.rcode`、`~/.ccode`
  （config.json / sessions/ / AGENTS.md / skills/）；会话 JSONL 的 schema 五版通用。
- 历史 bundle：[references/history/tcode-history.bundle](references/history/)（`git clone` 即可还原）。
- 修 bug 请对照笔记查其余版本的对应模块——一份修，五份同步。
