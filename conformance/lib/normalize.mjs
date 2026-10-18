// 归一化：raw 采集 → canonical result。分类映射表在此（schema §2 错误分类学），
// 判定不在本文件（归 lib/diff.mjs）。canonical 不携带完整 stdout/stderr。
import { readFileSync } from "node:fs";

/** 场景声明的标记 → 布尔/计数观测（S3 通道，包含/缺席语义）。 */
function extractMarkers(scenario, stdout, stderr) {
  const includes = {};
  for (const m of scenario.expect.stderr_markers?.includes ?? []) {
    includes[m] = stderr.includes(m);
  }
  const absent = {};
  for (const m of scenario.expect.stdout_markers?.absent ?? []) {
    absent[m] = stdout.split(m).length - 1; // 出现次数（期望 0）
  }
  // 次数上限断言（同标记重复出现即超限，如逐次询问被重复渲染）
  const maxCounts = {};
  for (const [m, limit] of Object.entries(scenario.expect.stdout_markers?.max_count ?? {})) {
    const count = stdout.split(m).length - 1;
    maxCounts[m] = { count, limit, ok: count <= limit };
  }
  return { stderr_includes: includes, stdout_absent: absent, stdout_max_counts: maxCounts };
}

/** S1 通道断言：第 n 个请求体内「最后一条 role=tool 消息」的锁定文案判定。 */
function lastToolMessage(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  return [...msgs].reverse().find((m) => m.role === "tool") ?? null;
}

/** 消息配对不变量（agent-loop 本质约束 1 / N2）：assistant.tool_calls 每个都有配对 tool 消息。 */
function noDanglingToolCalls(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const pending = new Set();
  for (const m of msgs) {
    for (const tc of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
      if (tc?.id !== undefined) pending.add(tc.id);
    }
    if (m?.role === "tool" && m?.tool_call_id !== undefined) pending.delete(m.tool_call_id);
  }
  return pending.size === 0;
}

/** R1 估算（context.md）：每条消息 content+8、每个 tool_call name+arguments 另计 +8，总和÷3 向上取整。 */
function estimateTokens(stat) {
  return Math.ceil((stat.message_chars + 8 * stat.message_count + 8 * stat.tool_call_count) / 3);
}

function providerChecks(scenario, raw) {
  const checks = [];
  for (const item of scenario.expect.provider_requests?.items ?? []) {
    const body = raw.bodies?.[item.nth - 1];
    if (!body) {
      checks.push({ check: `request#${item.nth} 存在`, ok: false, actual: "missing" });
      continue;
    }
    if (item.last_tool_message_equals !== undefined) {
      const lastTool = lastToolMessage(body);
      const actual = !lastTool
        ? "no_tool_message"
        : lastTool.content === item.last_tool_message_equals
          ? "equals"
          : `mismatch:${String(lastTool.content).slice(0, 80)}`;
      checks.push({
        check: `request#${item.nth} 最后一条 tool 消息 == 锁定文案`,
        ok: actual === "equals",
        actual,
      });
    }
    if (item.last_tool_message_startswith !== undefined) {
      const lastTool = lastToolMessage(body);
      const actual = !lastTool
        ? "no_tool_message"
        : String(lastTool.content).startsWith(item.last_tool_message_startswith)
          ? "matches"
          : `mismatch:${String(lastTool.content).slice(0, 80)}`;
      checks.push({
        check: `request#${item.nth} 最后一条 tool 消息 startswith ${JSON.stringify(item.last_tool_message_startswith)}`,
        ok: actual === "matches",
        actual,
      });
    }
    if (item.last_tool_message_includes !== undefined) {
      const lastTool = lastToolMessage(body);
      const content = String(lastTool?.content ?? "");
      const missing = item.last_tool_message_includes.filter((s) => !content.includes(s));
      checks.push({
        check: `request#${item.nth} 最后一条 tool 消息包含 ${JSON.stringify(item.last_tool_message_includes)}`,
        ok: !!lastTool && missing.length === 0,
        expected: "全部包含",
        actual: !lastTool ? "no_tool_message" : missing.length === 0 ? "all_matched" : `missing:${JSON.stringify(missing)}`,
      });
    }
    if (item.has_tool_message_equals !== undefined) {
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const hit = msgs.some((m) => m?.role === "tool" && m?.content === item.has_tool_message_equals);
      checks.push({
        check: `request#${item.nth} 存在 content 等于锁定占位文案的 tool 消息`,
        ok: hit,
        expected: item.has_tool_message_equals,
        actual: hit ? "found" : "not_found",
      });
    }
    if (item.has_tools !== undefined) {
      const stat = raw.requestStats?.[item.nth - 1];
      const actual = stat ? stat.has_tools : "no_stat";
      checks.push({
        check: `request#${item.nth} 是否携带 tools 期望 ${item.has_tools}`,
        ok: actual === item.has_tools,
        expected: item.has_tools,
        actual,
      });
    }
    if (item.no_dangling_tool_calls) {
      const ok = noDanglingToolCalls(body);
      checks.push({
        check: `request#${item.nth} 消息序列无悬空 tool_calls`,
        ok,
        expected: true,
        actual: ok ? "paired" : "dangling",
      });
    }
  }

  // 轮内治理断言（context.md R1 估算口径 + 本质约束 1）：每个请求体估算 ≤ 上限
  const estimateLimit = scenario.expect.provider_requests?.estimate_limit_tokens;
  if (estimateLimit !== undefined) {
    const over = (raw.requestStats ?? [])
      .map((s, i) => ({ nth: i + 1, tokens: estimateTokens(s) }))
      .filter((r) => r.tokens > estimateLimit);
    checks.push({
      check: `全部 ${raw.requestStats?.length ?? 0} 个请求体估算 ≤ ${estimateLimit} tokens`,
      ok: over.length === 0,
      expected: `≤ ${estimateLimit}`,
      actual: over.length === 0 ? "all_within" : over.map((r) => `#${r.nth}=${r.tokens}`).join(","),
    });
  }
  return checks;
}

/** S4 通道断言：fixture 终态（unchanged / 字节相等 / missing / changed）。 */
function artifactChecks(scenario, raw) {
  const checks = [];
  for (const [rel, expectation] of Object.entries(scenario.expect.artifacts ?? {})) {
    const initial = scenario.input.fixtures?.[rel];
    const now = raw.artifactContents?.[rel];
    const actual = now === null || now === undefined ? "missing" : expectation === "unchanged" ? (now === initial ? "unchanged" : "changed") : now === expectation ? "equals" : "mismatch";
    checks.push({ check: `artifact ${rel} ${expectation}`, ok: actual === "unchanged" || actual === "equals", actual });
  }
  return checks;
}

export function normalize(runtime, scenario, raw) {
  const base = { runtime, scenario: scenario.id };
  if (raw.kind !== "exited") {
    // 基建错误（超时/spawn 失败）：不产生行为判定（lessons L1/L2）
    return { ...base, infra: { kind: raw.kind, detail: raw.message ?? `timeout>${raw.timeoutMs}ms` } };
  }

  const markers = extractMarkers(scenario, raw.stdout, raw.stderr);
  const mentionsYolo = Object.entries(markers.stderr_includes)
    .filter(([k]) => k.includes("--yolo"))
    .some(([, v]) => v);

  // 进程面分类表（schema §2）：exit 1 + stderr 指认 --yolo → invalid_input；
  // 其余 exit≠0 → failed（分类表随场景类型扩展，判定归 diff）。
  let level;
  if (raw.exitCode === 0) level = "ok";
  else if (raw.exitCode === 1 && mentionsYolo) level = "invalid_input";
  else level = "failed";

  return {
    ...base,
    verdict: { level, exit: raw.exitCode },
    provider_requests: { count: raw.providerRequests, items: providerChecks(scenario, raw) },
    stderr_markers: markers.stderr_includes,
    stdout_markers: markers.stdout_absent,
    stdout_max_counts: markers.stdout_max_counts,
    artifacts: artifactChecks(scenario, raw),
  };
}

/** R-schema-1 门：场景源禁止出现实现词。 */
export function schemaGate(scenarioFile) {
  const text = readFileSync(scenarioFile, "utf-8");
  const banned = ["tcode", "pcode", "gcode", "rcode", "ccode", "typescript", "python", "golang", "rust", "csharp"];
  const hits = [];
  for (const word of banned) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(text)) hits.push(word);
  }
  return { ok: hits.length === 0, hits };
}
