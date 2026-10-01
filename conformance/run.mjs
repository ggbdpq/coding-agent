// 一致性 runner 入口：node conformance/run.mjs <scenario-id|all>
// 流程：R-schema-1 门 → 逐适配器 prepare(新鲜度门)/execute(只采集) → normalize → diff → 报告。
// 退出码：0=全 PASS；1=存在 DRIFT；2=存在 INFRA 或门失败（fail closed）。
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalize, schemaGate } from "./lib/normalize.mjs";
import { diffScenario } from "./lib/diff.mjs";
import { runScenario } from "./adapters/shared.mjs";

const CONF = fileURLToPath(new URL(".", import.meta.url));
const ADAPTER_NAMES = ["typescript", "python", "go", "rust", "csharp"];

function freshLabel(f) {
  if (!f.ok) return "FAIL";
  return f.kind === "interpreted" ? "interpreted" : `fresh sha256:${f.sha256}@${f.builtAt}`;
}

async function runOne(scenarioFile) {
  const scenarioPath = join(CONF, "scenarios", scenarioFile);
  const { default: scenario } = await import(pathToFileURL(scenarioPath).href);

  // R-schema-1 门：场景源零实现词
  const gate = schemaGate(scenarioPath);
  if (!gate.ok) {
    return { scenario, gateFail: `场景源命中实现词 ${JSON.stringify(gate.hits)}` };
  }

  const results = [];
  for (const name of ADAPTER_NAMES) {
    const { default: adapter } = await import(`./adapters/${name}.mjs`);
    const entry = { runtime: name };
    const prep = await adapter.prepare();
    entry.freshness = prep;
    if (!prep.ok) {
      entry.canonical = { runtime: name, scenario: scenario.id, infra: { kind: "freshness", detail: prep.reason } };
      entry.diff = { verdict: "INFRA", entries: [{ check: "freshness", detail: prep.reason }] };
      results.push(entry);
      continue;
    }
    const raw = await runScenario(adapter, scenario);
    entry.raw = {
      kind: raw.kind,
      exitCode: raw.exitCode,
      providerRequests: raw.providerRequests,
      stderrHead: (raw.stderr ?? "").slice(0, 300),
      stdoutHead: (raw.stdout ?? "").slice(0, 200),
    };
    entry.canonical = normalize(name, scenario, raw);
    entry.diff = diffScenario(scenario, entry.canonical);
    results.push(entry);
  }
  return { scenario, results };
}

function render(scenario, gateFail, results) {
  const lines = [];
  lines.push(`# ${scenario.id} Conformance Report`);
  lines.push("");
  lines.push(`- 时间：${new Date().toISOString()}`);
  lines.push(`- 场景：${scenario.title}`);
  lines.push(`- 规范锚：${scenario.related_specs.join("；")}`);
  lines.push(gateFail ? `- R-schema-1 门：**FAIL ${gateFail}**` : `- R-schema-1 门：PASS（零实现词）`);
  lines.push("");
  lines.push("| runtime | 执行链 | verdict | exit | provider_requests | 判定 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of results ?? []) {
    const c = r.canonical;
    const v = c.infra ? "—" : `${c.verdict.level}/${c.verdict.exit}`;
    const pr = c.infra ? "—" : c.provider_requests.count;
    lines.push(`| ${r.runtime} | ${freshLabel(r.freshness)} | ${v} | ${c.infra ? "—" : c.verdict.exit} | ${pr} | **${r.diff.verdict}** |`);
  }
  lines.push("");
  for (const r of results ?? []) {
    lines.push(`## ${r.runtime}`);
    lines.push("");
    lines.push(`- 执行链：${freshLabel(r.freshness)}`);
    if (r.raw) {
      lines.push(`- raw：kind=${r.raw.kind} exit=${r.raw.exitCode ?? "—"} providerRequests=${r.raw.providerRequests}`);
      lines.push(`- stderr（前 300 字符）：\n\n\`\`\`\n${q(r.raw.stderrHead)}\n\`\`\``);
      if (r.raw.stdoutHead) lines.push(`- stdout（前 200 字符）：\n\n\`\`\`\n${q(r.raw.stdoutHead)}\n\`\`\``);
    }
    lines.push(`- canonical：\`${q(JSON.stringify(r.canonical))}\``);
    lines.push(`- 判定：**${r.diff.verdict}**`);
    for (const e of r.diff.entries) {
      lines.push(`  - ${e.check}：期望 ${q(e.expected ?? "—")}，实际 ${q(e.actual ?? e.detail ?? "—")}${e.allow ? `（允许：${e.allow}）` : ""}`);
    }
    lines.push("");
  }
  if (results) {
    const hasDrift = results.some((r) => r.diff.verdict === "DRIFT");
    const hasInfra = results.some((r) => r.diff.verdict === "INFRA");
    lines.push(
      `## 总判定：${gateFail ? "GATE_FAIL" : hasDrift ? "DRIFT" : hasInfra ? "INFRA" : "PASS"}（${results.filter((r) => r.diff.verdict === "PASS").length}/${results.length} PASS）`,
    );
    lines.push("");
  }
  return lines.join("\n");
}

function q(s) {
  return String(s).replaceAll("`", "'");
}

// ---- 编排 ----
const id = process.argv[2];
if (!id) {
  console.error("用法: node conformance/run.mjs <scenario-id|all>   例如: SC-004A / all");
  process.exit(2);
}
const scenarioDir = join(CONF, "scenarios");
const files = readdirSync(scenarioDir)
  .filter((f) => f.endsWith(".mjs"))
  .sort();
const targets = id === "all" ? files : files.filter((f) => f.startsWith(id));
if (targets.length === 0) {
  console.error(`找不到场景 ${id}（scenarios/ 下无匹配）`);
  process.exit(2);
}

let exitCode = 0;
const summary = [];
for (const f of targets) {
  const { scenario, gateFail, results } = await runOne(f);
  if (gateFail) {
    console.error(`R-schema-1 门失败：${scenario.id} ${gateFail}`);
    summary.push(`${scenario.id}: GATE_FAIL`);
    exitCode = 2;
    continue;
  }
  const report = render(scenario, null, results);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(CONF, "reports", `${scenario.id}-${stamp}.md`);
  mkdirSync(join(CONF, "reports"), { recursive: true }); // fresh clone 上目录不存在（git 不带空目录）
  writeFileSync(out, report);
  const verdict = report.match(/## 总判定：(\w+)/)?.[1] ?? "UNKNOWN";
  summary.push(`${scenario.id}: ${verdict}`);
  console.log(`${scenario.id}: ${verdict}（报告: reports/${scenario.id}-${stamp}.md）`);
  if (verdict === "DRIFT") exitCode = exitCode === 0 ? 1 : exitCode;
  if (verdict === "INFRA" || verdict === "GATE_FAIL") exitCode = 2;
}
console.log(`== 汇总 ==\n${summary.join("\n")}`);
process.exit(exitCode);
