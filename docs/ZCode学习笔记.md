# ZCode 学习笔记（第二轮）

一句话：对 zai-org/ZCode（v3.14.3，2026-09-27 浅扫）的第二轮研究——第一轮（specs
骨架期）识别内核主干与 Top-5 设计模式并部分吸收进七篇 spec；本轮补读上轮未覆盖的
10 个设计面，按 `specs/methodology.md` 三档裁决（借 / 搁置候选 / 不学），并建立
"不学档案"防翻案无据。第一轮材料见 `specs/methodology.md` 与各篇 spec 的 ZCode 映射。

## 一、三档分类

### 借（思想 / 小改）

**8. system-reminder 来源表** —— "运行时→模型"控制平面的地基：20+ 来源注册表，
每项带 channel（request_prefix / current_turn / tool_result / history_continuity /
mid_turn）、lifecycle（是否持久化进 transcript）、providerVisibility；mid-turn steer
（用户插话/子 agent 回复/任务通知）格式化为带防注入指引的合成提醒。
落点：3.3 TUI / Subagent 启动时先建此表，注入类功能共用，现在不动。

**4. subagent 事件镜像** —— 子会话工具/权限事件换成 `tool_subagent` 前缀镜像 ID、
贴 agentId/childSessionId/source 后重发进父事件流；权限请求必须镜像，否则父壳无法
响应。价值：父壳零改动看到子活动。落点：3.3 Subagent 条目实现备忘。

**5. skills/hook 信任准入** —— 扫描只认根 SKILL.md + 一层子目录；错误契约只吞
ENOENT、EACCES 必上抛（防静默空索引）；plugin-scope symlink 一律拒绝（"拒绝即无
逃逸"）；hook 信任按配置 digest 指纹，内容一变即掉信，含 10 分钟审阅超时状态机。
落点：**已落地**（2026-09-27）——pcode 技能索引 `except OSError` → `except
FileNotFoundError`（EACCES 上抛）+ `test_systemprompt.py` 2 例（红转绿）；tcode
同病同修（删吞错 try/catch）+ 锁测试。**go/rust/cs 同病待五版同步**：SkillIndex
无错误通道，需签名小改（go 返 error / rust Result / cs throw），建议按 3.3 式登记
后统一动。symlink 边界 pcode 已达标（resolve + 包含检查），无需改。

**7. 事件式检查点 rewind** —— Edit/Write 的结构化输出（filePath/originalFile/
structuredPatch）校验通过即序列化为检查点事件入会话流；回退时从事件流选检查点、
恢复文件、经 reminder 通道注入 rewind_notice（desktop 另有 git 级检查点）。
价值：检查点 = 工具输出的 first-class 事件，比全库快照便宜。
落点：新增搁置条目（3.3），触发条件与取向见路线图。

### 搁置候选（记入 3.3 备忘）

**2. node-repl-host 廉价沙箱** —— 每次调用起一次性 Worker（连模块缓存一起销毁），
cell 用 vm createContext + 受限 process facade（防 cell 关进程/写坏协议 stdout）。
价值：廉价隔离优于重沙箱。落点：3.3 OS 沙箱条目实现取向。

**6. MCP** —— 连接池、超时、进程树回收（Windows Job Object）、全套 OAuth；
凭证不进插件进程（http 逐请求注入头、stdio 走 _meta）。按需最小化。
落点：3.3 MCP 条目备忘（进程树回收 + 凭证边界）。

### 已覆盖（思想与家族现状一致，不动作）

**1. TUI 壳零业务** —— "目录解释、持久化转录读归 bootstrap，TUI 只拥有选择/折叠/
渲染"；家族 REPL/exec 本就是"壳只渲染、turn 唯一生产者"。OpenTUI 本身不借。

**10. 多壳共享内核** —— 薄传输客户端（client 仅 3 个传输文件）+ 端口协议层，多壳
对同一内核说话；rpc 框架本身各语言用平台原生即可。

### 不学（进档案）

**3. dynamic-workflow** —— "纯度合同从编译期开始"（全虚拟 compiler host 跑真 tsc、
同一 ts.Program 复用作 schema 合成/site-graph/依赖推断/误用检查）思想记一句；
52 文件的 analysis 子系统与 SQLite journal 是团队级工程，单人项目负资产。

**9. stream-recovery 台账** —— 流式工具台账（input_streaming→committed/cancelled/
abandoned，标注只读/副作用范围）+ 已提交锚点截断 + 只读工具可重放。解决长流多工具
的断流恢复；家族已有断尾修复 + 仅首字节前重试（provider.md R7），规模不需要。
翻案触发：真实断流事故。

## 二、不学档案（已评估不采纳 + 翻案条件）

| 已拒绝项 | 当初为什么不学 | 翻案条件 |
| --- | --- | --- |
| Turn 状态机 | 隐式循环 + 40 轮常量已契约化（agent-loop.md）；状态机收益在"权限/steering 挂相位"时才显现 | 做 3.3 Subagent/TUI 需要相位挂载点 |
| 事件溯源 | 家族会话 = 消息 JSONL，事件是运行时投影（session-turn.md）；"三份同步"问题家族未出现 | 多壳共享实时状态、或做断流恢复（#9 连带翻案） |
| 异步权限 Broker | 同步闸门 + web 壳 permission 事件覆盖 v0.5 审批 | 权限确认需跨进程/远程回写（远程壳） |
| 事件式 rewind（机制层） | 思想借、机制不借——原生实现依赖事件溯源 | 事件溯源翻案时连带；或独立按"工具输出事件"轻量实现 |
| dynamic-workflow / 插件市场 / OAuth MCP | 3.4 不做清单 + 单人维护定位 | 不设——定位级决定 |

## 三、本轮落地记录（2026-09-27）

- **EACCES 错误契约**：`impls/python/pcode/core/systemprompt.py`（`except OSError` →
  `except FileNotFoundError`）+ `test/test_systemprompt.py` 2 例（红转绿）；
  `impls/typescript/src/core/systemprompt.ts` 删吞错 try/catch + `test/systemprompt.test.ts`。
  go/rust/cs 同病待五版同步（见上）。
- **路线图增量**：`docs/从零到一到一百.md` §3.3 四条既有大件补实现备忘/取向，
  新增搁置条目"检查点/rewind"。

## 四、证据边界

- 本轮为浅扫：每面读到"能下三档结论"的深度，未做实现级深挖；ZCode 持续漂移，
  动笔引用前重核对应文件仍在。
- 未确认项：node-repl-host 是否另有独立 NDJSON 通道（未见独立桥文件，对主进程即
  MCP-over-stdio）；TUI 渲染细节仍浅。
- 侦察成本：GitHub API 4 次请求，其余 raw 文件直读。

## 五、maka（第三轮补充，2026-09-27）

用户点名参照 apache/maka 的 "agent runtime" 设置（fork 实际路径
`E:\ggbdpq\gh-fork\maka`，npm workspaces、11+3 包）。九条拆解结论：

| 设计 | 裁决 |
| --- | --- |
| core 零依赖契约包（只有类型与事件 schema） | 已覆盖——kernel/types 即等价物，纪律已存在 |
| 日志即运行时（append-only 事件 log 唯一事实，"The log is the runtime"） | 维持不学——翻案条件不变（多壳实时共享/断流恢复），maka 证据已归档进不学档案 |
| 语义层不持进程/网络权威（runtime-kernel 无 fs/net import） | 学（成文）——已写进 ARCHITECTURE.md 管/不管表与实现内部纪律 |
| runtime-host 唯一执行权威 + 多客户端准入（"One Runtime Host…thin clients"） | 搁置候选——触发：一个会话需被两个壳同时看到（对应 3.3 TUI/远程壳），取向记 ARCHITECTURE.md |
| 权威分界"管/不管"表（职责可证伪） | 学（文档手法）——ARCHITECTURE.md 已用；七篇 spec 后续小修补"不管"列 |
| 测试 seam 即公共 API（test-only/fake-backend 进 exports） | 已大部分覆盖——五版单测即 fake 注入；"fake 是公共 API"记 ARCHITECTURE.md |
| eval dogfooding（把自己当 subject 走同一协议） | 搁置（低优先），取向一句 |
| 300 扁平单文件 + 140 子路径 exports | 不学——TS 生态特定，家族"一工具一文件"粒度已合适 |
| 45 篇 ADR + 根 ARCHITECTURE.md 阅读路径 | 学（轻量）——docs/adr/ 立制（ADR-001 即收口决策），只立制度不追数量 |

结构落点：本轮同步完成目录收口（impls/，见 docs/adr/ADR-001-目录收口.md）与根
ARCHITECTURE.md——根层学 language、实现内部学 maka，双参照合并方案生效。
