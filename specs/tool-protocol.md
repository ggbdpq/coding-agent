# Tool Protocol —— 工具契约（schema / preview / 确认声明）

一句话：工具与系统其余部分的唯一接口——八个字段的声明式契约、注册表三条规则、
function calling 线格式直传。权威出处：`impls/typescript/src/kernel/plugin.ts`、
`impls/typescript/src/kernel/registry.ts`。

状态：正文 v1（2026-09-27）。基于五版源码静态比对 + 单测验证；本主题五版语义一致
（含同文错误文案与同豁免矩阵），无代码裁决，表达法差异登记为允许偏差。
本轮为"装配顺序即优先级"补齐注册顺序锁测试（cs 既有，其余四版新增）。
主题边界：确认判定内部属 [permission.md](permission.md)；循环消费契约属
[agent-loop.md](agent-loop.md)；anthropic 侧 schema 字段映射属 Provider 主题（交界处只登记）。

## 本质约束

1. 工具是声明式契约，不是类继承——系统只认字段：schema 给模型、preview 给用户、
   needsPermission/skipPermission 给安全、run 给执行。
2. run 的错误是给模型的文本，不是给进程的异常——「错误一律以『错误：…』文本回流，
   不抛异常/不 panic」是工具实现的第一纪律。
3. 注册表保序：装配顺序即优先级（provider 首个 matches 命中生效，openai 兜底排最后）。
4. schema 原样直传 function calling：无 strict、无加工——契约面最小。

## 语言中立规则

- **R1 字段集**（8 字段）：`name` / `description` / `parameters`（JSON Schema object，
  原样直传）/ `needsPermission`（bool 静态声明：写类逐次确认、读类免确认）/
  `preview`（args→string，确认时展示给用户，必填）/ `skipPermission`（可选，
  args+app→bool，参数级豁免）/ `run`（args→string）；kind 判别字段/形态随语言
  表达法（字面量字段、外壳 struct、enum、抽象属性）。
- **R2 确认语义两层正交**：needsPermission 是静态声明，skipPermission 是参数级豁免
  （"此参数组合已被配置信任"）。豁免矩阵五版一致：write/edit 有白名单豁免；
  bash/web_fetch/apply_patch 明确不设豁免；read/glob/grep/todo 免确认。
- **R3 run 错误语义**：错误一律折叠为「错误：…」文本回流给模型自行纠正
  （py/go/rust 三版 plugin 定义处注释逐字同义，ts/cs 由实现示范）。
- **R4 注册规则**：同 kind 重名拒绝（文案统一「插件重名：kind/name」）；跨 kind
  同名允许；线性数组保序；一个插件恰好一种 kind（go 因外壳表示法以运行时校验表达）。
- **R5 schema 线格式**：`{"type":"function","function":{name,description,parameters}}`；
  空清单省略 tools 字段（不传空数组）；无 strict；anthropic 侧统一映射 `input_schema`。
- **R6 schemas 导出独立于注册表实例**（toSchemas/ToolSchemas）——agentloop 拿到的是
  裸工具数组，不经注册表。
- **R7 内置工具名单与注册顺序**（五版同序）：read, write, edit, bash, glob, grep,
  todo, web_fetch, apply_patch。

### 允许偏差（不收敛，登记在案）

| 偏差 | 版本 | 理由 |
| --- | --- | --- |
| kind/skipPermission/中止参数/同步异步/参数类型的表达法 | 各随语言 | 语言惯用；语义同构（cs 的 SkipPermission 虚方法默认 false ≡ 其余版"未声明"） |
| run 中止参数：signal / ctx / CancellationToken / 无 | ts / go / cs / py+rs | 平台真取消矩阵（Event 主题已登记） |
| 空插件校验 | 仅 go | 表示法产物：外壳 struct 能表达"全空"非法态，故运行时守卫 |
| ToolSchema 内部形状：线格式 vs 扁平+包壳推迟 | ts/py/go vs rust/cs | 线格式产出一致，归属层不同 |

## 边界与依赖方向

- 契约住 kernel：agentloop 消费 ToolDef、permission 消费两个权限字段、provider 消费
  schema——三方都不重定义工具接口。
- preview 只产文本不判定安全；skipPermission 只回答布尔不弹 UI；判定逻辑在
  Permission 主题。
- 组合根显式列出插件（无目录扫描），顺序即装配优先级。

## 五版落点

| 版本 | 契约定义 | 注册表 | 工具清单 |
| --- | --- | --- | --- |
| tcode | `src/kernel/plugin.ts:10-29` | `src/kernel/registry.ts` | `src/plugins/index.ts:30-38` |
| pcode | `pcode/kernel/plugin.py:18-35` | `pcode/kernel/registry.py` | `pcode/plugins/__init__.py:32-41` |
| gcode | `internal/kernel/plugin.go:22-37` | 同文件 `:86-143` | `internal/plugins/plugins.go:18-26` |
| rcode | `src/kernel/plugin.rs:13-28` | 同文件 `:76-178` | `src/plugins/mod.rs:15-23` |
| ccode | `kernel/Plugin.cs:10-81` | 同文件 `:86-120` | `kernel/PluginList.cs:18-26` |

## 分歧裁决（2026-09-27）

无代码裁决——五版语义一致。补齐注册顺序锁：cs 既有显式顺序断言，
ts/py/go/rust 各新增"注册顺序保持"测试（全部一次通过，证实行为一致）。

## 反例清单（对抗式审查）

- 同 kind 重名注册被静默接受（必须报「插件重名：kind/name」）。
- 跨 kind 同名被拒（必须允许）。
- 注册顺序倒置 → openai 兜底被靠前的通用 provider 遮蔽（顺序锁测试）。
- run 抛异常/panic 穿透循环（必须折叠为「错误：…」文本；防线归属见 agent-loop 允许偏差）。
- schema 被加 strict 或加工（契约直传）。
- 空工具清单把 `[]` 传给 openai（必须省略 tools 字段）。
- needsPermission 与 skipPermission 语义被合并（两层正交）。
- preview 缺省（必填——确认 UI 无内容可展示）。
- 九工具名单或注册顺序漂移（名单是 v0.5 能力线的一部分）。

## 低置信区

- anthropic 侧 schema 映射（input_schema）只登记行为，字段级校验归 Provider 主题。
- go 的空插件校验为表示法守卫，不构成五版契约差异（其余表示法下不可表达该非法态）。
- 行号为 2026-09-27 快照，会随代码漂移。

## 验证记录（2026-09-27）

- 单测：ts 50/50（registry 顺序锁 +1，`tsc --noEmit` 干净）、pcode 54/54（+1）、
  gcode 全包 ok（kernel 顺序锁 +1）、rcode 54/54（+1）；ccode 顺序锁既有未动。
- 零源码改动（纯测试），此前五版冒烟结果仍有效；ccode 未跑（缺 SDK）。
