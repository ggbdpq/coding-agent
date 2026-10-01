// 比对：canonical vs scenario.expect → PASS / ALLOW_DIFF / DRIFT / INFRA。
// fail closed：无法归类的差异一律 DRIFT（normalization-policy §0.3）。
// ALLOW_DIFF 仅当差异条目全部携带 policy E 条目引用（v1 场景暂无此类条目）。

export function diffScenario(scenario, canonical) {
  if (canonical.infra) {
    return { verdict: "INFRA", entries: [{ check: "infrastructure", detail: canonical.infra }] };
  }
  const entries = [];
  const expect = scenario.expect;

  if (canonical.verdict.level !== expect.verdict.level) {
    entries.push({ check: "verdict.level", expected: expect.verdict.level, actual: canonical.verdict.level });
  }
  if (canonical.verdict.exit !== expect.verdict.exit) {
    entries.push({ check: "verdict.exit", expected: expect.verdict.exit, actual: canonical.verdict.exit });
  }
  if (canonical.provider_requests.count !== expect.provider_requests.count) {
    entries.push({
      check: "provider_requests.count",
      expected: expect.provider_requests.count,
      actual: canonical.provider_requests.count,
    });
  }
  for (const check of canonical.provider_requests.items ?? []) {
    if (!check.ok) {
      entries.push({ check: check.check, expected: "equals", actual: check.actual });
    }
  }
  for (const [marker, present] of Object.entries(canonical.stderr_markers)) {
    if (!present) {
      entries.push({ check: `stderr.includes(${JSON.stringify(marker)})`, expected: true, actual: false });
    }
  }
  for (const [marker, count] of Object.entries(canonical.stdout_markers)) {
    if (count > 0) {
      entries.push({ check: `stdout.absent(${JSON.stringify(marker)})`, expected: 0, actual: count });
    }
  }
  for (const check of canonical.artifacts ?? []) {
    if (!check.ok) {
      entries.push({ check: check.check, expected: "unchanged/equals", actual: check.actual });
    }
  }

  const cited = entries.filter((e) => e.allow);
  if (entries.length === 0) return { verdict: "PASS", entries };
  if (cited.length === entries.length) return { verdict: "ALLOW_DIFF", entries };
  return { verdict: "DRIFT", entries };
}
