# conformance —— 可执行一致性层（tracer bullet）

依据 [ADR-002](../docs/adr/ADR-002-可执行一致性层.md)；协议见
[conformance-schema](../docs/conformance-schema.md)（观测面/错误分类学/场景字段）、
[归一化边界](../docs/conformance-normalization-policy.md)（N/E 条目 + fail closed）。

## 跑法

```bash
node conformance/run.mjs SC-004A     # 退出码：0=全 PASS；1=有 DRIFT；2=有 INFRA/门失败
```

当前场景：SC-001（Plan Mode）、SC-002A/B（apply_patch 成功/原子性）均 **frozen**
（五版 PASS + 红操演练转红）；SC-004-A（exec 契约）五版 PASS，红操待做仍为 draft。
报告落在 `reports/`。

## 结构与边界

```text
conformance/
├── run.mjs                  # 编排：R-schema-1 门 → prepare(新鲜度门) → execute(只采集) → normalize → diff → 报告
├── scenarios/               # 场景源 = ES module 数据对象（零 parser；R-schema-1 零实现词 grep 门）
├── adapters/                # 每语言一个薄适配：只启动、供输入、采集（stdout/stderr/退出码/请求数）
│   └── shared.mjs           # 沙箱隔离 + 假 provider 计数池 + 构建新鲜度门（lessons L1）
├── lib/                     # normalize（raw→canonical，含错误分类学映射）/ diff（PASS|ALLOW_DIFF|DRIFT|INFRA）
└── reports/                 # 每次运行的 Markdown 报告（含 raw 观测与 diff 依据）
```

不变式（违背即修）：

1. 适配器只采集、不判定；判定词汇只允许 schema §2 的错误分类学。
2. 新鲜度门失败 = 基建错误（INFRA），不产生行为判定（L1）。
3. 场景源零实现词；期望值只锚 specs 与被锁定公共接口，不抄任何实现的现行为。
4. diff 不可归类的差异一律 DRIFT（fail closed）；宽容必须引用 normalization-policy E 条目。

## 环境前提（L2）

- node ≥ 24（tcode 直跑 .ts）、python ≥ 3.12、go、cargo、dotnet SDK 8；
- Windows 自定义 .NET 安装位需要 `DOTNET_ROOT`——适配器已自动解析（`where dotnet`）。

## 已知边界（ponytail 记录）

- runner/normalizer/diff 在 tracer 阶段收敛为 3 个文件（`run.mjs` + `lib/`），场景数超过 3
  或出现第二类观测面时再拆目录；
- 假 provider 目前是**计数池**（只计数 + 500），SC-001/002/003 需要剧本回放时扩展为
  scriptable sink；
- 红操演练（R1：升 frozen 前手工注入反例必须转红）：SC-001 已完成（2026-10-01，
  rcode 临时注入拒写失效 → 精准 DRIFT → 回滚复绿）；SC-004-A 待做。
