# 一致性审计（Phase 0 · Conformance Audit）

日期：2026-10-01。方法：七篇规范全文通读 + 五语言实现逐仓静态探查 + **五套件当日全量实跑** +
现场根因诊断。结论先行：**行为语义层面未发现新漂移，但可执行验证层存在一处已被证实的静默失效
案例，且"五份手工副本"结构使这类失效无法自愈——这正是 Executable Conformance Suite 要解决的
问题。**

---

## 1. 行为规范来源

- **specs/ 正文 v1（2026-09-27）**：agent-loop / tool-protocol / session-turn / context /
  permission / provider / event 七篇，固定六栏（本质约束 / 语言中立规则 / 边界与依赖 /
  五版落点 / 反例清单 / 低置信区），已含 9 次分歧裁决与 6 张允许偏差登记表。
- **裁决链**：specs > tcode 源码（参考实现）> 教程笔记（ARCHITECTURE.md）。
- **可执行面现状**：specs/README 写作约定 2 指定"冒烟场景（A/B/C/D/F/H）是这套规范的可用
  可执行面，spec 变更后五版冒烟必须全绿"——即**事实上的准一致性层是五份语言内联的冒烟副本**。

## 2. Runtime 清单（2026-10-01 实测）

| 实现 | 规模(行) | 入口与模式 | 单元测试 | 冒烟 | 本日实跑 |
| --- | --- | --- | --- | --- | --- |
| tcode (ts) | 4131 | repl / exec / web 壳 / --approval | 54/54 | A/B/C/D/E1/E2/H（7） | ✅ 全绿 |
| pcode (py) | 5180 | repl / exec / /approval | 58/58 | A/B/C/D/F/H（6） | ✅ 全绿 |
| gcode (go) | 5989 | repl / exec / /compact 场景 | 12 文件 56 函数全包 ok | A/B/C/D/F/G/H+H₂（8） | ✅ 全绿 |
| rcode (rs) | 6337 | repl / exec / /approval | 55/55 | A/B/C/D/F/H/H₂（7） | ✅ 全绿（重编译后，见 §4.1） |
| ccode (cs) | 5193 | repl / exec | 63/63（含 6 冒烟场景） | 同左 | ✅ 全绿（**首次**，见 §4.2） |

工具链：node 24.21.0 / Python 3.14.7 / go 1.27.0 / cargo 1.98.1 / **dotnet 8.0.425（本机现在有
.NET SDK——七篇规范低置信区"ccode 缺 SDK 未复跑"的前提已失效）**。

**关键共性（一致性套件的现成接口）**：五版全部具备 `exec` 无交互模式（--yolo 强制、退出码携带
成败、事件渲染为 `[tool]/[result]` 纯文本行）；五版冒烟均为"**本地假 SSE 服务器 + 被测二进制
子进程 + stdin 喂行**"的黑盒驱动形态（tcode: test/smoke.mjs；pcode: test/smoke.py；gcode:
internal/smoke（go build 真二进制）；rcode: tests/smoke.rs（CARGO_BIN_EXE）；ccode:
tests/Smoke.cs（TcpListener 免 URLACL））。剧本路由同为"最后一条消息 role + 最新用户文本"。

## 3. 行为差异矩阵

### 3.1 已裁决允许偏差（specs 登记在案，不重复展开）

取消通道（AbortSignal/context/CancellationToken/无——py+rs 无轮中取消）、工具异常防线归属
（循环 catch vs 契约自守）、字段命名随语言惯用、py 白名单真实路径加严、py 300s 超时加严、
rs/cs 关闭重定向加严、EOF 残留半事件丢弃 vs 冲刷、`--approval` 与 `/approval` 的互补缺口
（tcode 缺 /approval）等——共 6 表 30 余条，见各 spec"允许偏差"节。

### 3.2 本次审计新发现（2026-10-01 实测）

| # | 发现 | 定性 | 处置建议 |
| --- | --- | --- | --- |
| 1 | **构建缓存击穿可执行层**：rcode 冒烟 7/7 全红，报错"启动子进程失败 NotFound(3)"；单测 55 全绿。根因：`CARGO_BIN_EXE_rcode` 是**编译期嵌入的绝对路径**，缓存的 smoke 测试二进制内嵌了失效的旧路径（`touch tests/smoke.rs` 强制重编译后 7/7 全绿）。**同款问题 ADR-001 后果节已于 09-27 登记过一次**；本日为第二次发生，证实其复发性与结构性风险——单测绿掩盖冒烟红、报错误导排查方向。 | 基建缺陷（非行为漂移），但它证明**可执行层会静默失效**——一致性套件必须内建产物新鲜度门 | 固化为 Build Freshness Invariant（docs/conformance-lessons.md L1）；一致性 runner 设计的第一约束，见 §5 |
| 2 | **ccode 验证欠账已清**：七篇规范低置信区反复登记"ccode 本机无 .NET SDK"；本日 dotnet 8.0.425 实跑 `dotnet run --project tests` 63/63 全绿，含 spec 留案"从未编译运行"的 TrimTests 空内容用例。 | 环境变化，规范过期 | Phase 1 校准时批量关闭低置信区；后续一致性套件进 CI 后此类欠账不再累积 |
| 3 | **gcode 流中断守卫语义需措辞校准**：spec（provider 允许偏差表）称 gcode"吞掉视作流正常结束"；实况为**传输层 EOF/读错误吞掉，用户取消不吞**（mid-stream ctx.Err() 走 aborted 语义，openai.go:122-124）。 | 规范措辞粒度问题（行为本身合理且与重试纪律一致） | Phase 1 措辞校准，一句话改 spec |
| 4 | **rust /approval 同步方向**：spec 反例清单称"双向同步"；实况为 **/approval→yolo 单向**（yolo 命令与权限答 `a` 只改 yolo Cell 不回写 config.approval，approval.rs 测试锁的也是单向）。 | 规范措辞 vs 实现失配 | Phase 1 裁决：改 spec 措辞（推荐，单向已够防"假生效"）或补回写 |
| 5 | **ccode exec 无时间预算**：总超时=InfiniteTimeSpan，请求仅链用户取消令牌（providers 无 linked CTS）；exec 模式遇挂起服务器将无限等待。 | 平台合从缺口（其余版有 socket 超时/取消语义） | 登记 spec 允许偏差表；是否加严走路线图 |
| 6 | **冒烟场景覆盖不对称**：web 壳 E1/E2 仅 tcode 有（其余版无 web 壳，属能力面差异）；/compact 冒烟 G 仅 gcode 有；exec 无 --yolo 反例 H₂ 仅 gcode+rcode 有；--continue 无专项冒烟（spec 已登记）。 | 覆盖面缺口 | Phase 3 场景集设计直接吸收：G/H₂/--continue 升格为一致性场景 |
| 7 | 文档漂移小点：根 README 族谱表"tcode 冒烟 6 场景"实为 7；ARCHITECTURE.md 未提 exec 模式（ccode 探查发现，五版均有）。 | 文档滞后 | Phase 1 顺手校准 |

### 3.3 漂移风险排名（Phase 2 的靶子）

1. **R1 可执行面 = 五份手工副本**：spec 变更需人肉同步五份冒烟；副本间已出现场景集分化（§3.2#6），
   且已发生过静默失效（§3.2#1）。**同一规范、五处实现、零机器比对**是当前最大结构性风险。
2. **R2 无跨实现比对机制**："五版一致"目前由"各自冒烟各自绿 + 人读笔记"保证；没有"同一输入 →
   五版输出同构"的机器判定与 diff 报告。
3. **R3 平台侧验证欠账**：rust 分隔符契约、路径列表 POSIX 行为在 Windows 上恒绿无红能力；
   py symlink 加严与其余四版词法归一的分歧无实测用例——需要非 Windows 执行面（CI ubuntu）。
4. **R4 spec 低置信区堆积**（§3.2#2/#3/#4/#5）：多为措辞与登记问题，一轮 Phase 1 校准可清零。

## 4. Phase 1-3 设计建议（供裁决，未动代码）

- **Phase 1（校准）**：一轮 spec 措辞校准（§3.2 #3/#4/#5/#7）+ 低置信区批量关闭（#2），
  零行为变更或按裁决补最小代码。
- **Phase 2（Executable Conformance Suite）**：新增根层 `conformance/`（结构变更，按仓库纪律
  走 ADR）——**单一场景源（语言中立 fixture：输入脚本 + 假 SSE 剧本 + 期望断言契约）→ 五个薄
  适配器（复用五版现成 exec 模式与假 SSE 驱动形态）→ 统一 runner → 跨实现 diff 报告**。
  关键决策点：runner 宿主语言（建议 Node，家族 CI/工具链最轻）、期望契约的归一化口径
  （退出码 + stdout 标记行 + 请求体特征，避开语言惯用差异）、被测二进制的构建与新鲜度门
  （直接吸收 §3.2#1 教训）。
- **Phase 3（首批 Case）**：Plan Mode 拒写 / apply_patch 原子性 / tool error 折叠 /
  invalid input 四条为全五版同断言；cancellation 单列（py+rs 无轮中取消，按平台分档断言）；
  吸收 G（compact）、H₂（exec 反例）、--continue 进场景集。
- **CI**：ubuntu runner 一次性补齐 R3 的 POSIX 侧红能力（分隔符契约在 POSIX 下首次可获得
  真实红绿）。
