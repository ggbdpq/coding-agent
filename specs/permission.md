# Permission —— 权限闸门（三态 / 写白名单 / 审批策略）

一句话：工具执行的唯一安全边界——yolo 先行，白名单豁免写类，其余逐次三态询问，
"always" = 会话级 yolo。权威出处：`impls/typescript/src/core/permission.ts`。

状态：正文 v1（2026-09-27）。基于五版源码静态比对 + 单测与冒烟验证；
一处平台合从缺陷已按写作约定 1 裁决修复（见"分歧裁决"）。
主题边界：needsPermission/skipPermission 的契约声明属 Tool Protocol；Plan Mode 拒写
发生在闸门之前，属 Agent Loop。

## 本质约束

1. 未经用户明示同意（yolo / 白名单 / 逐次放行），needsPermission 工具不得执行——
   默认拒绝是底线。
2. 免确认的三条通道都是"用户事先说过可以"：启动声明（--yolo / never）、
   路径白名单（allowWriteDirs）、会话记忆（always）。
3. 闸门运行期只认 yolo 引用；任何策略改动必须同步 yolo，否则假生效。
4. bash/web_fetch 不设白名单豁免——命令级/网络级操作无法按路径约束。

## 语言中立规则

- **R1 决策顺序**（固定四步）：needsPermission 工具执行前——① yolo → 放行；
  ② skipPermission 白名单 → 放行；③ 询问用户三态；④ 非 deny 即放行本次。
- **R2 三态映射**：y→allow（本次）、n/空→deny、a→always；deny 时向模型回固定话术
  「用户拒绝了本次操作。请询问用户怎么办，或换一种方式；不要未经允许重试同样的操作。」
  （五版同文）。
- **R3 always 记忆** = 置会话级 yolo 布尔：进程内、不持久化、全局粒度
  （不分工具/参数）；提示文案注明可用 /yolo 切回。
- **R4 白名单语义**：未配置（空）一律不豁免；目标等于根目录、或位于
  根目录+分隔符之下才豁免（分量级前缀，不收字符串同名前缀 `/a/b` vs `/a/bc`）；
  `..` 先归一化再比较，穿越出根即失配；仅挂 write/edit。
- **R5 白名单配置**：config.json `allowWriteDirs` 优先，否则环境变量
  `<PREFIX>_ALLOW_WRITE` 按平台路径列表分隔符切分；逐项归一为绝对路径，
  空段滤除（空串归一会静默送出 cwd）。
- **R6 审批策略**：枚举仅 normal|never；normal = 默认逐次确认；never ≡ --yolo
  （启动时单向合并进 yolo）；非法值必须报错，不静默采用默认。
- **R7 询问 UI**：y/a/n/空 四分支、提示文案逐字一致；确认中 Ctrl+C / stdin 关闭
  = deny。

### 允许偏差（不收敛，登记在案）

| 偏差 | 版本 | 理由 |
| --- | --- | --- |
| 白名单归一化用真实路径解析（触盘解 symlink、大小写由文件系统裁决） | py | 加严：symlink 逃逸在 py 下失配回确认；其余四版词法归一。五版同步加严为候选演进 |
| Windows 跨盘符 relpath 异常的显式 outside 特判 | py | 鲁棒性加严 |
| 策略默认值表达 undefined/None vs 显式 "normal" | go/cs 显式 | 语言惯用 |
| `--approval` CLI 参数 | 仅 tcode | 能力面差异（兄弟版走环境变量 + config） |
| `/approval` 运行期命令（改策略 + 同步 yolo） | 仅 tcode 无 | 能力面差异（py 自述为移植期任务规格新增）；tcode 补齐为候选演进 |
| 闸门签名 async / sync | ts/cs vs py/go/rs | 实现层 |

## 边界与依赖方向

- permission 是安全边界的唯一份；agentloop 经 deps.check 回调使用，不内联判定。
- 闸门不感知工具实现：preview 文本由工具提供，闸门只传话。
- 运行期改策略的命令（/approval）必须同步 yolo 引用——闸门只读 yolo。

## 五版落点

| 版本 | 闸门 | 白名单判定 | 策略配置 |
| --- | --- | --- | --- |
| tcode | `src/core/permission.ts:18-28` | `plugins/tools/write.ts:11-20`、`edit.ts:56-65`（内联） | `src/kernel/config.ts:67-83` |
| pcode | `pcode/core/permission.py:27-38` | `plugins/tools/pathguard.py:33-45`（共享） | `kernel/config.py:77-93` |
| gcode | `internal/core/permission.go:36-47` | `internal/plugins/tools/pathguard.go:40-54` | `internal/kernel/config.go:87-113` |
| rcode | `src/core/permission.rs:31-48` | `src/plugins/tools/pathguard.rs:13-55` | `src/kernel/config.rs:95-133` |
| ccode | `core/Permission.cs:28-35` | `plugins/tools/PathGuard.cs:25-34` | `kernel/Config.cs:77-97` |

## 分歧裁决（2026-09-27，写作约定 1：要么改代码要么改规格）

1. **rust 分隔符硬编码**：`RCODE_ALLOW_WRITE` 用 `';'` 切分（config.rs:124），
   其余四版按平台 path.delimiter → POSIX 上行为偏离准绳，判定为平台合从缺陷。
   修复：提取 `path_list_separator()`（Windows ';' / POSIX ':'），分隔符契约测试锁定。
   注：本机 Windows 上新旧行为同值、无法产生红；红能力在 POSIX runner 上成立——
   POSIX 侧验证未完成，如实登记。

## 反例清单（对抗式审查）

- bash/web_fetch 声明 skipPermission（测试钉死：py/go 的 skip_permission 为 None/nil）。
- 白名单未配置却豁免（空 = 不豁免，五版测试均锁）。
- `/a/bc` 命中白名单 `/a/b`（分量级前缀，rust 测试显式锁）。
- 目标经 `..` 穿越出根仍获豁免（归一化后失配）。
- 空字符串白名单段归一后送出 cwd（滤空段在先）。
- `/approval never` 不同步 yolo → 假生效（rust approval.rs 注释点破，测试锁双向同步）。
- 策略非法值静默采用默认（必须报错）。
- always 记忆被持久化或按工具名分粒度（契约：进程内全局布尔）。
- 确认中 Ctrl+C 被当作 allow（= deny）。

## 低置信区

- rust 分隔符修复的 POSIX 行为本机不可验证（Windows 上与旧实现同值）。
- py 真实路径解析在 symlink 场景与其余四版的判定分歧未构造实测用例（登记为允许加严）。
- `--approval` / `/approval` 的互补缺口属能力面，收敛需走路线图（3.3 搁置机制）。
- ccode 本机无 .NET SDK，ApprovalTests 未随本轮复跑（本主题未改 csharp 源码）。
- 行号为 2026-09-27 快照，会随代码漂移。

## 验证记录（2026-09-27）

- 单测：rcode 52/52（含新增分隔符契约锁）；本主题未改 ts/py/go/cs 源码
  （tcode 47/47、pcode 51/51、gcode core ok 均为此前验证）。
- 冒烟：rcode 7/7（config 源码改动后复跑）；其余版本源码未动。
