# 学习指南：tcode v0.4 的 headless、@引用与会话 picker

> 面向读者：读过 tcode 现有代码的人。三个小特性，一条共同主线：
> **把同一个内核接到更多入口上**。

## 1. 一句话定义

v0.4 的三个功能都是"给同一个内核换入口/加前处理"：exec 是命令行入口（无交互单任务）、
@引用是输入前处理（把文件展开进消息）、--continue//sessions 是会话入口的便捷面。

## 2. 要素与类比

| 要素 | 类比 | 落点 |
| --- | --- | --- |
| exec 无交互模式 | 快递柜：投递（任务）→ 处理 → 取件（退出码），全程无人值守 | main.ts 的 exec 分支：要求 --yolo，退出码 0=完成 / 1=出错 |
| @文件引用 | 会议前发材料：你提一句"@见附件"，材料内容自动进所有人的桌面 | src/core/atrefs.ts 的 `expandAtRefs`（输入前处理纯函数） |
| --continue //sessions | 书签：合上书（退出）再打开（启动）直接翻到上次那页 | main.ts 启动段 + plugins/commands/sessions.ts |

## 3. 破误解

**"exec 是一个新壳，要注册进 shell 插件。"** 不需要。shell 插件是**长交互会话**的
抽象；exec 没有会话循环，只是"装配 → 跑一轮 → 带退出码退出"的直通路径，写在
main.ts 装配层更诚实。判断标准：需要 readline/事件订阅的才是壳。

**"@引用应该做成一个工具，让模型自己决定读不读。"** 两种都对，但语义不同：
@引用是**用户主动的上下文注入**（用户决定），read 工具是**模型自主的检索**
（模型决定）。前者省一轮往返且保证读到；后者省 token 但多一轮。都保留。

## 4. 本仓库调用链

- exec：`main.ts` 解析 `exec` 位置参数 → `runUserTurn(app, task, { emit })` →
  事件渲染成 `[tool]`/`[result]` 行 → `process.exitCode` 携带成败。
- @引用：`core/atrefs.ts` 的 `expandAtRefs(line, readFile)`——读文件函数参数注入，
  纯函数可单测（`test/atrefs.test.ts`：缺失标注/多引用/256KB 截断）。
- 会话：`--continue` 在装配后调 `store.listRecent(1)` + `load`，`/sessions` 复用
  `listRecent(5)`——与 `/resume` 共用一份存储语义。

## 5. 语言对照

exec 的本质是**无头入口**：codex `exec`、MCode `mcode exec` 同构。@引用在
ZCode/MCode 里还支持目录与图片；tcode 先做单文件文本。真取消（ccode/gcode）
在 headless 里对应"SIGTERM 时取消令牌联动"——v0.4 未做，v0.5 候选。

## 6. 下一步

- exec 支持 `--continue` 已通（装配层统一）；给 exec 补 JSON 输出模式（`--json`）。
- @引用支持目录（展开为 glob 结果）与行号范围（`@file:10-20`）。
- Plan Mode（第二批）：只读轮复用 exec 的"无写类确认"思路反推白名单。
