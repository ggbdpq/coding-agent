# Provider —— 双协议客户端（识别 / SSE / 重试）

一句话：一个模型接口、两种线协议——BASE_URL 含 `/anthropic` 走 Anthropic 协议，
否则 OpenAI 兼容兜底；手写 SSE 解析；重试只属于首字节之前。
权威出处：`impls/typescript/src/providers/`。

状态：正文 v1（2026-09-27）。基于五版源码静态比对 + 单测与冒烟验证；
tcode 一处违背自身重试纪律的缺口已按写作约定 1 裁决修复（见"分歧裁决"）。
主题边界：usage 数值来源与事件化属 [event.md](event.md)；工具 schema 映射已在
[tool-protocol.md](tool-protocol.md) 登记。

## 本质约束

1. 只支持流式——coding agent 的体感底线，也让工具调用前的等待可见。
2. "仅首字节前可重试"是内容完整性纪律：正文已开始接收后中断绝不重试，
   否则内容重复、计费翻倍。
3. 用户中止（取消）在任何阶段都绝不重试。
4. 协议差异在 provider 层终结：模型词汇（ChatMessage/ChatOptions/CompletionResult）
   是内核唯一事实，协议细节（端点/头/SSE 事件名/字段名）不出 providers。

## 语言中立规则

- **R1 协议识别**：anthropic 当且仅当 BASE_URL 含子串 `/anthropic`（区分大小写）；
  openai `matches` 恒真兜底且必须注册在 provider 清单最后；按注册顺序首个命中生效；
  显式口子 `<PREFIX>_PROTOCOL`（或 config.json `protocol`）按名直选，值仅限
  openai|anthropic，非法值报错。
- **R2 端点与请求**：openai `POST {base}/chat/completions` + `authorization: Bearer`；
  anthropic `POST {base}/v1/messages` + `x-api-key` + `authorization: Bearer`（双发）
  + `anthropic-version: 2023-06-01`。
- **R3 anthropic 请求变换**：max_tokens=8192；system 提为顶层 `system`（换行 join）；
  tool 消息转 user 角色 `tool_result` 块；assistant 的 tool_calls 转回 `tool_use` 块；
  相邻同角色消息合并；tools 映射 `name/description/input_schema`；`stream: true`。
- **R4 SSE 手写解析**：空行分事件；只取 `data:` 行并 trim；多行 data 以 `\n` 连接；
  非 JSON 行静默跳过（注释/心跳）；openai 侧 `[DONE]` 结束；空 data 不产出。
- **R5 增量聚合**：content 累加并回调 onText；tool_calls 按 index 分槽——id 覆盖、
  name/arguments 字符串拼接；按 index 升序输出；空 id 兜底 `call_{i}`（openai）/
  `toolu_{i}`（anthropic）；空 arguments 补 `'{}'`；anthropic arguments 做
  JSON roundtrip 归一、失败保留原文（截断兜底交工具层报错）。
- **R6 错误分类**：HTTP 429 与 5xx 可重试（anthropic 语义含 529）；其余状态不可重试；
  错误体截 300 字符入消息；anthropic 流内 `error` 事件立即失败。
- **R7 重试纪律**：恰好 3 次尝试；指数退避 1s、2s；**流已开始（正文接收中）的中断
  不重试**——读流中断必须改写为不可重试错误（TypeError/网络类异常会命中重试白名单，
  必须在 provider 源头改写）；用户中止绝不重试；退避等待期间取消要能打断。
- **R8 tools 传参**：空工具清单省略 tools 字段（不传空数组）。

### 允许偏差（不收敛，登记在案）

| 偏差 | 版本 | 理由 |
| --- | --- | --- |
| 流中断语义的编码机制：显式转 RuntimeError / 吞掉视作流正常结束 / 视作完成 / 异常类型白名单排除 | py / go / rs / cs | 语义一致（都不重试），机制随语言错误模型；tcode 修复后同列 |
| EOF 残留半事件：丢弃（sse 规范派）vs 冲刷（宽容派） | ts/py vs go/rs/cs | 在"非 JSON 行跳过"保护下两者皆安全；影响仅限省略收尾空行的非规范服务端。收敛为候选演进 |
| 529 显式列出 vs 靠 >=500 覆盖 | ts/py/cs vs go/rs | 语义等价 |
| 超时：py 300s socket 超时（加严）；ts/go 无；rs 仅 compact 20s；cs 总超时关死靠取消令牌 | 各版 | 平台与成熟度差异；py 为加严 |
| 自动重定向：rs/cs 显式关闭 vs ts/py/go 跟随 | rs/cs 加严 | 重定向会改写目标端点，关闭更稳；记加严 |
| 可重试错误载体 / 中止向量 | 各随语言 | 语言惯用与平台（Event 主题矩阵） |
| SSE 实现形态（整块缓冲 vs 逐行 vs ReadLine） | 各版 | 规则等价 |

## 边界与依赖方向

- providers 依赖 kernel（config/types/plugin.definePlugin）；内核不 import providers——
  经注册表装配（Tool Protocol R4 的顺序即优先级）。
- 手写 SSE、零 HTTP 框架依赖（家族纯标准库约束）。
- 协议识别失败不存在（openai 恒真兜底）；手动 protocol 直选失败必须报错并列可用名。

## 五版落点

| 版本 | openai / anthropic | SSE / retry |
| --- | --- | --- |
| tcode | `src/providers/openai.ts` / `anthropic.ts` | `src/providers/sse.ts` / `retry.ts` |
| pcode | `pcode/providers/openai.py` / `anthropic.py` | `pcode/providers/sse.py` / `retry.py` |
| gcode | `internal/providers/openai.go` / `anthropic.go` | `internal/providers/sse.go` / `retry.go` |
| rcode | `src/providers/openai.rs` / `anthropic.rs` | `src/providers/sse.rs` / `retry.rs` |
| ccode | `providers/OpenAi.cs` / `Anthropic.cs` | `providers/Sse.cs` / `Retry.cs` |

## 分歧裁决（2026-09-27，写作约定 1：要么改代码要么改规格）

1. **tcode 流中断可重试缺口**：retry.ts:1-4 注释宣称"流已开始的中断不重试"，
   但读流中断以 TypeError 冒泡会命中 `RetryableError || TypeError` 白名单
   （retry.ts:20）——真实可触发（断连后重试 1s+2s 两次，内容重复）。其余四版均有
   防线（py 显式转 RuntimeError、go 吞掉视作流结束、rs 视作完成、cs 类型排除），
   判定 tcode 违背自身注释的缺口。修复：openai/anthropic 读流循环包 try——
   AbortError 原样上抛、其余改写为不可重试的「流中断：…」；anthropic 流内 error
   事件改置标志停读（与 rust 的 in_stream_error 同法），避免被二次包装。
   回归锁：`test/retry.test.ts` 三例（假 SSE 服务器 + 连接计数）——流中断只连一次
   （修前红：3 次连接含退避 3.1s）、429 退避重试成功共两次、400 立即失败只一次。

## 反例清单（对抗式审查）

- 断连后重试导致部分内容重复出现（修复 1 的回归锁：连接计数 = 1）。
- 用户 Ctrl+C 在流中断路径被吞成普通错误或触发重试（AbortError 原样上抛且绝不重试）。
- 429 永不重试直接失败（可重试白名单回归锁：连接计数 = 2）。
- 400/401 触发退避重试（不可重试：连接计数 = 1）。
- BASE_URL 含 `/anthropic` 却走了 openai 协议；protocol 非法值静默采用默认。
- anthropic 请求丢 system / 把 tool 消息直传（必须转 tool_result）/ 丢 max_tokens。
- tool_calls 碎片按到达顺序而非 index 装配；arguments 未拼接直接覆盖。
- anthropic input_json_delta 碎片丢失（分两片是 smoke C 的显式考验）。
- 空工具清单传 `[]` 给 provider（必须省略）。
- 错误响应体超长未截断（300 字符上限）。

## 低置信区

- 重试锁测试本轮仅 ts 新增；go/rust 的流中断守卫、py/cs 的显式防线均无直接测试
  （行为由源码结构与注释承载）——四版补镜像测试为候选演进。
- EOF 尾事件丢弃 vs 冲刷未收敛（见允许偏差）；如实测遇到省略收尾空行的服务端再裁决。
- 超时/重定向策略五版不一（py/rs/cs 各有加严），是否统一走路线图裁决。
- ccode 本机无 .NET SDK，本轮未复跑（本主题未改 csharp 源码）。
- 行号为 2026-09-27 快照，会随代码漂移。

## 验证记录（2026-09-27）

- 单测：ts 53/53（新增 `test/retry.test.ts` 3 例：流中断红转绿——修前 3 次连接
  含 3.1s 退避，修后 1 次；`tsc --noEmit` 干净）。本主题未改 py/go/rs/cs 源码。
- 冒烟：tcode exit=0 七场景全过（providers 源码改动后复跑）；其余版本源码未动。
