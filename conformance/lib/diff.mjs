// 比对：canonical vs scenario.expect → PASS / ALLOW_DIFF / DRIFT / INFRA。
// fail closed：无法归类的差异一律 DRIFT（normalization-policy §0.3）。
// ALLOW_DIFF 仅当差异条目全部携带 policy E 条目引用；allowPolicy 由 runner 显式传入
// （过渡期宽容只存在于 runner/policy 层，场景源与归一化层不做隐式宽容）。

export function diffScenario(scenario, canonical, allowPolicy = null) {
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
  if (
    expect.provider_requests.count !== undefined &&
    canonical.provider_requests.count !== expect.provider_requests.count
  ) {
    entries.push({
      check: "provider_requests.count",
      expected: expect.provider_requests.count,
      actual: canonical.provider_requests.count,
    });
  }
  if (
    expect.provider_requests.min_count !== undefined &&
    canonical.provider_requests.count < expect.provider_requests.min_count
  ) {
    entries.push({
      check: "provider_requests.min_count",
      expected: `>= ${expect.provider_requests.min_count}`,
      actual: canonical.provider_requests.count,
    });
  }
  for (const check of canonical.provider_requests.items ?? []) {
    if (!check.ok) {
      entries.push({ check: check.check, expected: check.expected ?? "equals", actual: check.actual });
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
  for (const [marker, r] of Object.entries(canonical.stdout_max_counts ?? {})) {
    if (!r.ok) {
      entries.push({
        check: `stdout.count(${JSON.stringify(marker)}) ≤ ${r.limit}`,
        expected: `≤ ${r.limit}`,
        actual: r.count,
      });
    }
  }
  for (const check of canonical.artifacts ?? []) {
    if (!check.ok) {
      entries.push({ check: check.check, expected: "unchanged/equals", actual: check.actual });
    }
  }

  if (entries.length === 0) return { verdict: "PASS", entries };
  if (allowPolicy) {
    // 显式宽容：逐条引用 normalization-policy 条目（fail open 仅限已登记条目，且由 runner 控制）
    for (const e of entries) if (!e.allow) e.allow = `${allowPolicy}`;
    return { verdict: "ALLOW_DIFF", entries };
  }
  const cited = entries.filter((e) => e.allow);
  if (cited.length === entries.length) return { verdict: "ALLOW_DIFF", entries };
  return { verdict: "DRIFT", entries };
}
