# Conformance Scenario Schema（v1 设计冻结）

状态：设计冻结（2026-10-01），依据 [ADR-002](adr/ADR-002-可执行一致性层.md)。
本文只定义**协议**：一个 Agent 行为如何被机器描述与判定。不包含 runner、adapter、
序列化格式绑定与任何代码——它们是 Phase 2，且必须能仅凭本文实现。

一句话定位：scenario 描述**行为**（给定输入，Agent 应产生什么可观测后果），
不描述实现（哪个语言、哪个函数、哪种启动方式）。

## 1. 观测面（Seams，先于一切断言冻结）

跨版一致性只允许在以下四个观测通道上断言。这是"约定好的接缝"——五版现成外部接口，
无需修改任何 runtime 即可采集：

| 通道 | 内容 | 为什么跨版同构 |
| --- | --- | --- |
| S1 `provider_requests` | 假 SSE 服务器收到的每个请求（路径 + 线格式 body） | 五版都对着同一 OpenAI/Anthropic 线协议说话——**线协议本身就是家族契约**（provider.md） |
| S2 `process_verdict` | 退出码及其等级（exec 契约：0=完成，1=失败/拒绝） | 五版 exec 退出码语义一致（ADR-002 将其升格为被锁定的公共接口） |
| S3 `stdout_markers` | 输出中的标记行（`[tool]`/`[result]`）与规范锁定文案 | 只做**包含/缺席**断言，绝不做全文相等——渲染文本不是契约 |
| S4 `artifacts` | 沙箱 HOME 内 fixture 文件的最终字节 | 文件系统效果是工具语义的最终事实 |

会话 JSONL（S5）暂不开放：v1 场景无此需求（YAGNI），需要会话级断言时再立。
机器可读事件流（如 `--format json`）属 runtime 修改，被本阶段禁止；v1 的 canonical
事件从 S1+S3 推导，升级路径留待 runtime 侧主动提供。

## 2. 错误分类学（Error IR）

跨版比较的最小公共词汇。规范对"错误"定义了三个不同层面，分类学必须分开：

**模型面（tool 消息的 content 类别）**——agent-loop R3 五出口 + tool-protocol R3：

| 类别 | 含义 | 规范锚 |
| --- | --- | --- |
| `result` | 正常工具结果 | agent-loop R3 |
| `tool_error_folded` | 工具失败折叠为「错误：…」文本回流，循环继续（可恢复） | tool-protocol R3 |
| `unknown_tool` | 「错误：未知工具 {name}。可用工具：{列表}」（锁定模板） | agent-loop R3 |
| `refused_plan_mode` | Plan Mode 拒写全文（逐字锁定） | agent-loop R6 |
| `refused_by_user` | 「用户拒绝了本次操作。…」（逐字锁定） | agent-loop R7、permission R2 |

**进程面（verdict 等级）**：

| 等级 | 含义 | 规范锚 |
| --- | --- | --- |
| `ok` | 正常完成 | — |
| `invalid_input` | CLI 契约违反（如 exec 缺 --yolo、缺任务） | 各版入口契约 |
| `aborted` | 用户取消（**分档**：ts/go/cs 支持轮中；py/rs 进程级退出，见 SC-005） | event R7、允许偏差登记 |
| `failed` | turn error / provider fatal | event R7 |

原文豁免规则：除上述锁定文案外，错误**原文**随语言惯用（`e.message`/`str(e)`/
`e.Message`——agent-loop 允许偏差表），断言只到类别为止。

## 3. Scenario 记录字段（v1，最小集）

每个字段必须挣得自己的位置；没有"预留字段"。

### 3.1 metadata

| 字段 | 约束 |
| --- | --- |
| `id` | `SC-###`，全局唯一，不复用 |
| `title` / `purpose` | 一句话：验证什么行为 |
| `related_specs` | **规则级**引用：`spec 文件名 + 规则号`（如 `agent-loop.md#R6`）。审计者必须能据此回答"这个场景依据哪条规范" |
| `maturity` | `draft`（设计完成未实跑）→ `frozen`（五版首跑通过） |
| `coverage` | `all`，或 `partial` + capability matrix（runtime × supported/partial/unsupported） |

### 3.2 input

| 字段 | 约束 |
| --- | --- |
| `fixtures` | `{沙箱 HOME 相对路径: 内容}`，内容一律 LF；禁止绝对路径与平台相关写法 |
| `entry` | `exec` 或 `repl-script`（stdin 逐行喂入，含 slash 命令） |
| `task` / `stdin_lines` | 用户任务或喂入序列 |
| `approval` | `yolo` / `interactive` |
| `protocol` | `openai` / `anthropic`（S1 断言按所选协议分形） |
| `model_script` | **逻辑响应步序列**：`text` / `tool_call{name,arguments}` / `final`。路由 = 剧本序（沿用五版冒烟"最后消息 role + 剧本序"约定）。协议编码（SSE 分片、input_json_delta 等）归 adapter，不入 scenario——分片考验保留在各版自有冒烟 C 场景 |

### 3.3 expect

| 字段 | 约束 |
| --- | --- |
| `verdict` | 等级 + 退出码（S2） |
| `provider_requests` | 有序列表，每项 = S1 断言：`body_includes`（结构性 JSON 路径断言，如 `messages[-1].role == "tool"`）+ 角标引用锁定文案 |
| `events` | S3 断言：标记行**包含/缺席**（如 `absent: ["[tool] write"]`） |
| `artifacts` | S4 断言：`{路径: 字节相等 | unchanged}` |

### 3.4 设计规则（对 scenario 源的硬约束）

- **R-schema-1 零实现词**：scenario 源禁止出现五种语言/实现名、runtime 路径、私有 API。
  机器可查（grep 门），也是"第六语言零改动"承诺的可验证形式。
- **R-schema-2 期望值锚定 specs**：锁定文案与行为契约的期望值**只能取自 specs**，
  禁止从任一实现的现行为抄录——参考实现不是规范（ARCHITECTURE 裁决链）。
- **R-schema-3 断言必锚规则**：每条 expect 断言可指认 `related_specs` 中的规则；
  指认不出 = 场景不收。
- **R-schema-4 允许差异显式引用**：scenario 内不做隐式宽容；宽容一律引用
  [conformance-normalization-policy](conformance-normalization-policy.md) 的条目号。

### 3.5 示例（SC-002 完整形态；其余场景只列差异字段）

```yaml
id: SC-002
title: apply_patch 原子性——任一文件操作失败则零写入
purpose: 验证补丁语义的原子性与失败折叠为可恢复错误
related_specs: [tool-protocol.md#R3]
maturity: draft          # 五版首跑通过后升 frozen
coverage: all
input:
  approval: yolo
  protocol: openai
  entry: exec
  task: "按补丁更新文件"
  fixtures:
    "notes/a.md": "alpha\n"
    "notes/b.md": "beta\n"
  model_script:
    - tool_call:
        name: apply_patch
        arguments:            # 第一个文件合法；第二个 old_string 不匹配 → 整体失败
          - file: notes/a.md
            change: { old: "alpha", new: "ALPHA" }
          - file: notes/b.md
            change: { old: "不存在的原文", new: "x" }
    - final: { text: "补丁未能应用。" }
expect:
  verdict: { level: ok, exit: 0 }
  provider_requests:
    - nth: 2
      body_includes:
        - messages[-1].role == "tool"
        - messages[-1].content startswith "错误："     # N5 类别=tool_error_folded；原文豁免
  events:
    absent: []                       # 无额外缺席要求（工具确实执行并回了错误文本）
  artifacts:
    "notes/a.md": unchanged          # 原子性核心：合法的第一文件也不得写入
    "notes/b.md": unchanged
```

## 4. 首批五场景（设计冻结，未实现）

### SC-001 Plan Mode 拒写（状态机 + 判定次序）

- `related_specs`: agent-loop.md#R6、permission.md（判定次序：闸门/preview/白名单之前）
- input: `entry: repl-script`，stdin = [`/plan`，任务："把配置写入 notes/a.md"]；`approval: interactive`；
  剧本：步1 `tool_call write`，步2 `final`。
- expect: artifacts `notes/a.md: unchanged`；第 2 次请求 `messages[-1].role=="tool"` 且 content
  =**拒写全文逐字**（agent-loop R6 锁定）；S3 断言 `absent: ["[tool]"]`（不执行、不发事件、
  不询问）；verdict ok。
- 验证的行为：拒写判定先于一切执行面；拒写文本回流供模型改出计划。

### SC-002 apply_patch 原子性

见 §3.5 完整示例。验证：任一文件操作失败 → 全补丁零写入 + 失败折叠回流（tool-protocol R3）。

### SC-003 Tool Error 折叠（可恢复错误语义）

- `related_specs`: tool-protocol.md#R3、agent-loop.md#R3/R4
- input: `exec`/yolo/openai；剧本：步1 `tool_call write`（arguments 缺必填字段——参数级
  非法），步2 `final`。
- expect: 第 2 次请求含 role:tool 且 content startswith「错误：」（类别 `tool_error_folded`，
  原文豁免）；artifacts unchanged；verdict ok。
- 验证的行为：工具失败是模型可修的输入而非进程错误（循环不变量五出口）。
- 预检注：若某版对缺参走出别的出口（崩溃/静默），那是**真漂移**——正是套件要抓的。

### SC-004 Invalid Input（边界行为，双臂）

- `related_specs`: agent-loop.md#R3（未知工具）、各版入口契约（exec）
- 臂 A（CLI 契约）：`exec` 不带 `--yolo` → verdict `invalid_input`（exit 1）、
  `provider_requests: 0`（模型零调用）、stderr 含 `--yolo` 指引。
- 臂 B（模型侧未知工具）：剧本步1 `tool_call {name: nonexistent_tool}`，步2 `final` →
  第 2 次请求含 role:tool 且 content =「错误：未知工具 nonexistent_tool。可用工具：…」
  （agent-loop R3 锁定模板，工具清单部分按版本豁免）；S3 断言 `absent: ["[tool]"]`；
  verdict ok。

### SC-005 Cancellation（分档，partial coverage）

- `related_specs`: permission.md#R7、event.md#R7、允许偏差登记（取消通道矩阵）
- 臂 A（**全五版可断言**）：`approval: interactive`，剧本步1 `tool_call bash`；确认等待中
  **关闭 stdin** → 依 permission R7（确认中 stdin 关闭 = deny），第 2 次请求含
  `refused_by_user` 锁定话术；verdict ok。验证"中止落在安全侧"。
- 臂 B（轮中止，**分档登记不比对**）：mid-stream SIGINT —— ts/go/cs `supported`
  （turn_end=aborted）；py/rs `unsupported`（进程级退出，aborted 无生产者）。
  本臂 v1 只登记 capability matrix，不出跨版断言；升级条件：py/rs 实现轮中取消（走路线图）。

### 覆盖记账

五场景对 specs 反例清单的映射：agent-loop R3/R4/R6/R7、tool-protocol R3、permission R2/R7、
event R7 均有场景承接；provider 主题（重试/SSE/协议识别）**不在首批**——它们已被各版
retry 单测与冒烟 C/D 覆盖，一致性套件首批聚焦 Agent 行为面（ADR-002 非目标：不追 100%）。

## 5. 验收（Phase 2 的红线）

1. 五场景**全部**可被 §3 字段完整表达，无 schema 外的隐含断言；
2. 场景源通过 R-schema-1 grep 门（零实现词）；
3. 每条断言可指认 spec 规则号；每条宽容可指认 normalization policy 条目号；
4. 陌生开发者仅凭本文 + normalization policy + 五版 README 可实现 runner——
   **且当前仓库中不存在任何 conformance 代码**。

## 6. v1 明确不做

序列化格式绑定（YAML/JSON 由 Phase 2 定）；S5 会话通道；机器可读事件流（runtime 修改）；
SSE 分片/协议识别场景（留在各版冒烟）；第 6 个场景。
