# 学习指南：tcode v0.5 的 Plan Mode、apply_patch 与技能索引

> 面向读者：跟完 v0.3/v0.4 的实现，想理解 v0.5 三个能力怎么落地。

## 1. 一句话定义

v0.5 = **一个模式**（Plan Mode：写类工具在轮内被拒，只读探索产出计划）、
**一个工具**（apply_patch：多文件原子补丁，全预验才写入）、
**一个约定**（技能目录：markdown 放进 skills/ 就出现在系统提示词索引里）。

## 2. 要素类比

| 要素 | 类比 | 落点 |
| --- | --- | --- |
| Plan Mode | 参观模式的眼罩：能看不能碰，看完给方案 | `src/core/agentloop.ts` 轮内守卫 + `plugins/commands/plan.ts` |
| apply_patch | 先核账再发货：所有订单（编辑）先验证库存（old_string 唯一），缺一件整单不发 | `src/plugins/tools/apply_patch.ts` 两阶段 |
| 技能索引 | 墙上的菜单：菜单（索引）进系统提示词，菜（正文）按需用 read 端上来 | `src/core/systemprompt.ts` 的 `skillIndex` |

## 3. 破误解

**"原子补丁需要事务文件系统。"** 不需要。tcode 的工具循环是串行的（没有并发写者），
所以"全部预验 → 顺序写入"就是实际原子——验证所有 old_string 存在且唯一之后才碰磁盘，
失败清单逐条报告（`test/patch.test.ts` 的"任一失败零写入"例锁死该语义）。

**"技能要用加载器/DSL。"** 技能就是 markdown 文件；"索引注入 + 按需 read"用现有
read 工具就完成了分发。等约定不够（比如要参数化技能）再升级加载器。

## 4. 本仓库调用链

- `/plan`：`plugins/commands/plan.ts` 切 `app.planMode` 并在 messages[0] 维护
  Plan Mode 分节；agentloop 轮内守卫（`planMode.value && needsPermission` →
  拒绝文本回流 + onToolResult）。
- apply_patch 两阶段：`plugins/tools/apply_patch.ts` 先全量预验（读文件+唯一性），
  再逐文件写入；跨文件重命名/批量调整的场景收益最大。
- 技能索引：`core/systemprompt.ts` 的 `skillIndex`（扫描 `~/.tcode/skills/` 与
  `<cwd>/.tcode/skills/`，只列名字与首行说明，正文按需 read）。

## 5. 语言对照

Plan Mode 在 ccode 最省事（CancellationToken 天然支持"取消+拒绝"两态）、gcode 次之
（NotifyContext 管取消，"只读拒绝"靠 agentloop 守卫）、pcode/rcode 需要把拒绝做成
工具结果文本（同步模型）。apply_patch 的难点不在语言在算法：精确匹配 + 预验即可，
不需要模糊上下文对齐。

## 6. 下一步

- Plan Mode 增加"计划持久化"（计划写进 todo 工具已支持，可再加会话文件记录）。
- apply_patch 支持 unified diff 格式（对齐 codex apply-patch crate）。
- 技能支持参数化（frontmatter 元数据），再评估是否值得上正式加载器。
