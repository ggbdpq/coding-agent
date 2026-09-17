# 2026-09-18 同一 agent 的三种语言表达（tcode / pcode / gocode）

## 决策

经用户裁决启动三语言计划：原 gcode（TypeScript）更名 **tcode**，同目录层新增
**pcode**（Python ≥3.12 纯标准库）与 **gocode**（Go 1.26 纯标准库）。三版行为规格
以 tcode 为准：八工具、SSRF 三道闸、权限三态闸门、会话 JSONL（schema 通用，理论上
跨实现 resume）、双协议（OpenAI/Anthropic）、裁剪/重试/熔断/断尾修复语义逐条对齐。
范围裁剪：web 壳与 desktop 是 tcode 独有交付，不移植；同步语言下 Ctrl+C 为"退出进程"
（tcode 的三态路由依赖 AbortSignal，同步模型无此能力），是仅有的两条已知行为差异。

## 规模对照

| | tcode (TS) | pcode (Py) | gocode (Go) |
| --- | --- | --- | --- |
| 行数（src+test） | 2766 | 3256 | 3845 |
| 源/测文件数 | 26 | 48 | 41 |
| 依赖 | 0 | 0 | 0 |
| 验证 | tsc + node:test 17 + 冒烟 6 场景 | unittest 17 + 冒烟 5 场景 | go vet + go test（4 组单测 + 冒烟 5 场景）+ gofmt 零差异 |
| 真机验收 | DeepSeek 工具轮 ✅（09-17） | DeepSeek 工具轮 ✅（09-18，exit=0） | DeepSeek 工具轮 ✅（09-18，exit=0） |

行数递增（TS<Py<Go）主要来自三处：Go 的错误处理与接口样板、Python 的类型标注、
以及各语言"惯用表达"比压缩写法更长——三版都刻意选择了惯用而非省行。

## 同一设计的语言表达（精选对照）

| 设计点 | tcode | pcode | gocode |
| --- | --- | --- | --- |
| 插件类型 | TS interface + kind 判别 | dataclass + kind 字段 | struct + 四选一字段 |
| SSE 解析 | 手写 async generator（ReadableStream reader） | 手写生成器（响应对象逐行迭代；管道 read(n) 凑满才返回的坑用 read1 解） | 手写 `iter.Seq`（bufio.Scanner 空行分事件） |
| 流式中断 | AbortController 三态路由 | 无（同步模型，Ctrl+C 退出进程，退出前仍补断尾落盘） | 同左 |
| IPv6 判定 | 正则匹配 ::ffff: 前缀 + 字符串形状 | `ipaddress` 标准库（覆盖 `0:0:0:0:0:0:0:1` 展开形式，强于 tcode 的正则） | `net.ParseIP` + `To4()` 拆回 v4 复判（同样强于 tcode） |
| 子进程 | node:child_process + taskkill | subprocess + 线程泵输出 + taskkill | exec.Command + goroutine 收集 + taskkill |
| 测试 | node:test + 自写假 SSE http 服务 | unittest + ThreadingHTTPServer | go test + httptest + 真二进制子进程 |

**值得一记的反哺**：pcode 与 gocode 的 IPv6 判定都嫁接了各自语言的标准库能力，
覆盖了 tcode 正则方案认不出的展开形式（如 `0:0:0:0:0:0:0:1`）。三语言对照不是
重复劳动，是互相打补丁。

## 过程

- 双 agent 并行构建（pcode/gocode 各一名），规格书写入派工 prompt；agent 只建和验，
  主会话逐项复核后提交——复核时真跑单测/冒烟/真机，不采信报告。
- Python 特有坑两枚（已固化注释）：管道 `read(n)` 凑满才返回导致尾巴卡死（用 `read1`）；
  逐字节解码拆碎多字节中文（整体解码）。
- Go 编译器偶发 STATUS_ACCESS_VIOLATION，重跑即好（与 Go test 并发崩溃同类）。

## 后续

- 任一语言修 bug，其余两版要对照同步（行为规格以 tcode 为准绳）。
- web 壳移植（pcode/gocode）与插件外置等扩张，等真实需求再启动。
