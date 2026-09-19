# 2026-09-18 同一 agent 的四种语言表达（tcode / pcode / gocode / rcode，后增 ccode）

## 决策

经用户裁决启动多语言计划：原 gcode（TypeScript）更名 **tcode**，同目录层新增
**pcode**（Python ≥3.12 纯标准库）、**gocode**（Go 1.26 纯标准库）、**rcode**
（Rust，仅 serde_json+ureq 两个直接依赖——标准库无 TLS/JSON 的语言现实让步）、
**ccode**（C# / .NET 8 纯内置，零 PackageReference）。三版行为规格
以 tcode 为准：八工具、SSRF 三道闸、权限三态闸门、会话 JSONL（schema 通用，理论上
跨实现 resume）、双协议（OpenAI/Anthropic）、裁剪/重试/熔断/断尾修复语义逐条对齐。
范围裁剪：web 壳与 desktop 是 tcode 独有交付，不移植；同步语言下 Ctrl+C 为"退出进程"
（tcode 的三态路由依赖 AbortSignal），是同步语言的已知行为差异——**ccode 是例外**：
CancellationToken 把三态真取消完整移植，是五语言里唯一做到的，也是 ccode 的核心考点。

## 规模对照

| | tcode (TS) | pcode (Py) | gocode (Go) | rcode (Rust) | ccode (C#) |
| --- | --- | --- | --- | --- | --- |
| 行数（src+test） | 2766 | 3256 | 3845 | 4168+323 文档 | 3557 |
| 源/测文件数 | 26 | 48 | 41 | 47 | 40 |
| 依赖 | 0 | 0 | 0 | 2（serde_json/ureq） | 0 |
| 验证 | tsc + node:test 17 + 冒烟 6 场景 | unittest 17 + 冒烟 5 场景 | go vet + go test（4 组单测 + 冒烟 5 场景）+ gofmt 零差异 | cargo test（20 单测 + 冒烟 5 场景） | dotnet build + 手写运行器 33 测试（含冒烟 5 场景） |
| 真机验收 | DeepSeek 工具轮 ✅（09-17） | DeepSeek 工具轮 ✅（09-18，exit=0） | DeepSeek 工具轮 ✅（09-18，exit=0） | DeepSeek 工具轮 ✅（09-18，exit=0） | DeepSeek 工具轮 ✅（09-18，exit=0） |
| 轮中真取消 | ✅（AbortController 三态） | ❌（退出进程） | ❌（退出进程） | ❌（退出进程） | ✅（CancellationToken，五语言唯一同步移植成功之外另达标者） |

行数递增大势（TS<Py<C#<Go<Rust）主要来自三处：Go 的错误处理与接口样板、Python 的类型
标注、Rust 的手写替代件（SSE/URL 解析/HTML 剥壳/civil 历法）——三版都刻意选择了惯用
而非省行。

## 同一设计的语言表达（精选对照）

| 设计点 | tcode | pcode | gocode |
| --- | --- | --- | --- | --- | --- |
| 插件类型 | TS interface + kind 判别 | dataclass + kind 字段 | struct + 四选一字段 | trait 对象 + kind 枚举 | 抽象基类 + kind 判别 |
| SSE 解析 | 手写 async generator（ReadableStream reader） | 手写生成器（响应对象逐行迭代；管道 read(n) 凑满才返回的坑用 read1 解） | 手写 `iter.Seq`（bufio.Scanner 空行分事件） | 手写（BufReader 逐行 + EOF 残留收尾） | 手写（StreamReader + 取消令牌贯穿） |
| 流式中断 | AbortController 三态路由 | 无（同步模型，Ctrl+C 退出进程，退出前仍补断尾落盘） | 同左 | 同左 | **✅ CancellationToken 完整移植三态**（本版中心考点） |
| IPv6 判定 | 正则匹配 ::ffff: 前缀 + 字符串形状 | `ipaddress` 标准库（覆盖 `0:0:0:0:0:0:0:1` 展开形式，强于 tcode 的正则） | `net.ParseIP` + `To4()` 拆回 v4 复判（同样强于 tcode） | `IpAddr::from_str` + `to_ipv4_mapped()`（同上） | `IPAddress.Parse` + `MapToIPv4()`（同上） |
| 子进程 | node:child_process + taskkill | subprocess + 线程泵输出 + taskkill | exec.Command + goroutine 收集 + taskkill | std::process + taskkill | Process + taskkill |
| 测试 | node:test + 自写假 SSE http 服务 | unittest + ThreadingHTTPServer | go test + httptest + 真二进制子进程 | cargo test + TcpListener 手写假服务器 + CARGO_BIN_EXE 子进程 | 手写断言运行器 + TcpListener 假服务器 + 真二进制子进程 |
| JSON | 无需（JS 原生） | json 标准库 | encoding/json 标准库 | serde_json（语言让步） | System.Text.Json 内置 |

**值得一记的反哺**：pcode/gocode/rcode/ccode 四版的 IPv6 判定都嫁接了各自语言的
标准库能力，覆盖了 tcode 正则方案认不出的展开形式（如 `0:0:0:0:0:0:0:1`）。多语言
对照不是重复劳动，是互相打补丁。ccode 额外贡献了两个 .NET 特有坑的解法（已固化注释）：
`JsonObject.ToJsonString()` 默认把中文转义成 `\uXXXX`（需 UnsafeRelaxedJsonEscaping）；
`Environment.GetFolderPath` 不认 HOME/USERPROFILE 重定向（会打穿测试隔离，需改读
环境变量）。

## 过程

- pcode/gocode 双 agent 并行、rcode/ccode 各一名（共四名），规格书写入派工 prompt；
  agent 只建和验，主会话逐项复核后提交——复核时真跑单测/冒烟/真机，不采信报告。
- Python 特有坑两枚（已固化注释）：管道 `read(n)` 凑满才返回导致尾巴卡死（用 `read1`）；
  逐字节解码拆碎多字节中文（整体解码）。
- Go/Rust 编译器各偶发过一次崩溃（STATUS_ACCESS_VIOLATION），重跑即好。
- Bun 兼容性实测：`bun bin/tcode.js` 零改动通过六场景冒烟（Bun 1.4），主运行时仍为 Node 24。
- 版本全部 0.3.0；gcode 的真取消是本批唯一的能力升级（其余为事件/压缩移植）。
- 移植学习指南各一份：`docs/guides/事件与取消.md`（gcode/ccode）、`事件与压缩.md`（pcode/rcode）。

## R4/R5/v0.4 移植（2026-09-19 追记）

tcode v0.4.0（exec 无交互/@文件引用/会话 picker/compact 尾部保留+80% 双档）与
R4/R5（审批策略+写白名单+skipPermission、usage 事件+/init）已移植到全部四个兄弟
实现，全部独立复核 + DeepSeek 真机 exec+@引用 验收（exit=0）：

| | R4 审批+白名单 | R5 usage/init | v0.4 三件 |
| --- | --- | --- | --- |
| gcode (Go) | ✅ 空段跳过（严于 tcode） | ✅ usage 分片先于判空消费（踩坑） | ✅ |
| ccode (C#) | ✅ 先剔空段再归一化（有意偏离 tcode） | ✅ | ✅ |
| pcode (Py) | ✅ is_relative_to 判定 | ✅ usage 块随空 choices 到达须先解析（踩坑） | ✅ |
| rcode (Rs) | ✅ 空段先滤（堵 cwd 意外入名单的洞） | ✅ | ✅ |

- 版本全部 0.4.0；各附移植笔记 `docs/guides/v04移植笔记.md`。
- ccode agent 首次因账户限速失败零落盘，git status 证实后原规格重派一次即成。
- 本轮语言反哺：白名单空段处理（ccode/gcode/rcode 三版都比 tcode 首版严）、
  usage 分片解析顺序——多实现对照再次当场抓出基准版的疏漏。

## v0.5 四件移植（2026-09-19 追记）

tcode v0.5.0 四件（Plan Mode / apply_patch 原子补丁 / previewDiff 行级 diff 预览+edit
preview 接线 / Skill 索引）已移植到全部四个兄弟实现，版本全部对齐 0.5.0；主会话逐项
复核（读 diff 对规格）并亲跑单测+冒烟全绿。本轮真机未跑（本机无 provider 配置/密钥），
行为验证以单测+冒烟为准：

| | previewDiff | apply_patch | Plan Mode | Skill 索引 |
| --- | --- | --- | --- | --- |
| gcode (Go) | ✅ +edit 接线，消融 truncateRunes | ✅ 写入失败按工具惯例返回错误文本 | ✅ 拒写判定在白名单之前 | ✅ |
| ccode (C#) | ✅ +edit 接线 | ✅ 复用 EditTool.ReplaceFirst（private→internal） | ✅ 另加"拒绝不发 tool_call 事件"断言 | ✅ |
| pcode (Py) | ✅ +edit 接线 | ✅ 读写 newline='' 保 CRLF | ✅ getattr 适配最小假 app | ✅ |
| rcode (Rs) | ✅ +edit 接线，消融 truncate_runes | ✅ 类型不符视同字段缺失 | ✅ plan_mode: Rc<Cell<bool>> | ✅ |

- 各附移植笔记 `docs/guides/v05移植笔记.md`。
- 本轮复核抓出的缺口：pcode/gcode/ccode 首交都把 V5-3 做成"纯函数"而漏了 edit
  preview 接线（rcode agent 自行对照 tcode 提交补上）——纯函数没有消费方就是死代码，
  移植"升级 X 的预览"类需求时要把消费方一起接走。

## 后续

- 任一语言修 bug，其余四版要对照同步（行为规格以 tcode 为准绳）。
- web 壳移植（其余语言）与插件外置等扩张，等真实需求再启动。
