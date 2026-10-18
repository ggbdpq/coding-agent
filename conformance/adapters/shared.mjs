// 适配器共享件：沙箱隔离、可剧本化假 provider、fixture 读写、stdin 脚本驱动、
// 构建新鲜度门（lessons L1）。适配器只采集不判定；分类归 lib/normalize.mjs，比对归 lib/diff.mjs。
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// 路径一律相对本文件计算：conformance/adapters/ → conformance/ → impls/
export const CONF_DIR = fileURLToPath(new URL("..", import.meta.url));
export const ARTIFACTS = join(CONF_DIR, ".artifacts");
export const IMPLS = fileURLToPath(new URL("../../impls/", import.meta.url));

const FAMILY_PREFIXES = ["TCODE_", "PCODE_", "GCODE_", "RCODE_", "CCODE_"];

/** 沙箱：独立 HOME/USERPROFILE + 剥离五族环境变量（防宿主配置串扰）。 */
export function sandboxEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "conf-sandbox-"));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "HOME" || k === "USERPROFILE") continue;
    if (FAMILY_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, ...extra });
  return { home, env };
}

/** 场景 fixtures 写入沙箱 HOME；返回写入的绝对路径表。 */
export function writeFixtures(home, fixtures = {}) {
  for (const [rel, content] of Object.entries(fixtures)) {
    const abs = join(home, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** 回读 fixture 终态字节（S4 artifacts 通道的采集侧）。 */
export function readFixtures(home, fixtures = {}) {
  const out = {};
  for (const rel of Object.keys(fixtures)) {
    const abs = join(home, rel);
    out[rel] = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }
  return out;
}

/** OpenAI 线格式编码：逻辑响应步 → SSE 帧（tool_calls 一帧整发，分片考验留在各版自有冒烟）。
 * - step.tool_call.arguments：对象，JSON.stringify 后发送（旧剧本路径，行为不变）；
 * - step.tool_call.raw_arguments：原样字符串发送（WP7：用来造非法/截断 JSON），与 arguments 互斥；
 * - step.finish_reason：覆盖缺省值（tool_calls / stop），截断场景用 "length"。 */
function encodeOpenaiSse(step) {
  const frames = [];
  if (step.tool_call) {
    const args =
      step.tool_call.raw_arguments !== undefined
        ? step.tool_call.raw_arguments
        : JSON.stringify(step.tool_call.arguments);
    frames.push({ choices: [{ delta: { role: "assistant" } }] });
    frames.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: step.tool_call.name, arguments: args },
          }],
        },
      }],
    });
    frames.push({ choices: [{ delta: {}, finish_reason: step.finish_reason ?? "tool_calls" }] });
  } else {
    const text = step.text ?? step.final?.text ?? "";
    const mid = Math.max(1, Math.ceil(text.length / 2));
    frames.push({ choices: [{ delta: { role: "assistant" } }] });
    frames.push({ choices: [{ delta: { content: text.slice(0, mid) } }] });
    frames.push({ choices: [{ delta: { content: text.slice(mid) } }] });
    frames.push({ choices: [{ delta: {}, finish_reason: step.finish_reason ?? "stop" }] });
  }
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
}

/** 请求体采集（S1 通道的原始计数，不做估算/判定；估算公式归 lib/normalize 按 spec R1 计算）。 */
function collectBodyStats(body) {
  const stats = {
    message_chars: 0,
    message_count: 0,
    tool_call_count: 0,
    has_tools: Array.isArray(body?.tools) && body.tools.length > 0,
  };
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    stats.message_count += 1;
    if (typeof m?.content === "string") stats.message_chars += m.content.length;
    for (const tc of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
      stats.tool_call_count += 1;
      stats.message_chars +=
        String(tc?.function?.name ?? "").length + String(tc?.function?.arguments ?? "").length;
    }
  }
  return stats;
}

/**
 * 假 provider：记录每个请求体（S1 通道）与请求体原始计数（供 normalize 按 spec 估算），
 * 按「最后一条消息 role」或「请求序号」路由剧本。
 * - model_script = { kind: "tool-then-text", tool, final_text }：user→工具调用，tool→final 文本；
 * - model_script = { kind: "steps", steps: [...] }：第 N 次请求回放 steps[N-1]，超出剧本返回 500
 *   （与无剧本一致，视为漂移证据）；
 * - 无剧本（SC-004 类）：只计数 + 500——收到请求即漂移证据。
 */
export function startSink(modelScript) {
  const scripted = modelScript?.kind === "tool-then-text";
  const stepped = modelScript?.kind === "steps" && Array.isArray(modelScript.steps);
  let count = 0;
  const bodies = [];
  const stats = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      count += 1;
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {}
      if (body) {
        bodies.push(body);
        stats.push(collectBodyStats(body));
      }
      let sse = null;
      if (scripted && body) {
        const lastRole = body?.messages?.at(-1)?.role;
        sse =
          lastRole === "user"
            ? encodeOpenaiSse({ tool_call: modelScript.tool })
            : lastRole === "tool"
              ? encodeOpenaiSse({ text: modelScript.final_text })
              : null;
      } else if (stepped) {
        const step = modelScript.steps[count - 1];
        sse = step ? encodeOpenaiSse(step) : null;
      }
      if (sse) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(sse);
      } else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":{"message":"conformance sink"}}');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        count: () => count,
        bodies: () => bodies,
        stats: () => stats,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function newestMtime(dir, exts, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "target" || name === "obj" || name === "bin" || name === ".venv" || name === "__pycache__") continue;
      newestMtime(p, exts, acc);
    } else if (exts.includes(extname(name))) {
      acc.push(st.mtimeMs);
    }
  }
  return acc;
}

/**
 * 构建新鲜度门（L1）：产物缺失或早于最新源码时强制重建；
 * 重建后仍不新鲜/不存在 = 基建错误（不产生行为判定）。
 * 通过时携带执行链证据：sha256 + 构建时间（CI 报告可验证执行链）。
 */
export function ensureFresh({ label, binPath, sourceDirs, sourceExts, build }) {
  const needs = () => {
    if (!existsSync(binPath)) return "missing";
    const binMtime = statSync(binPath).mtimeMs;
    const src = sourceDirs.flatMap((d) => newestMtime(d, sourceExts));
    const newest = src.length ? Math.max(...src) : 0;
    return binMtime < newest ? "stale" : "fresh";
  };
  let state = needs();
  if (state !== "fresh") {
    const r = spawnSync(build.cmd, build.args, { cwd: build.cwd, stdio: "pipe", shell: false });
    if (r.status !== 0) {
      return { ok: false, label, reason: `build failed: ${String(r.stderr).slice(0, 400)}` };
    }
    state = needs();
  }
  if (state !== "fresh") {
    return { ok: false, label, reason: `unfresh after build (${state})` };
  }
  const content = readFileSync(binPath);
  return {
    ok: true,
    label,
    kind: "built",
    sha256: createHash("sha256").update(content).digest("hex").slice(0, 16),
    builtAt: new Date(statSync(binPath).mtimeMs).toISOString(),
  };
}

/** 带超时的进程执行（exec 模式）：采集 stdout/stderr/退出码，不做任何判定。 */
export function runCapture({ cmd, args, cwd, env, timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, shell: false });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        resolve({ kind: "timeout", timeoutMs });
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ kind: "spawn_error", message: String(e) });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ kind: "exited", exitCode: code, stdout, stderr });
    });
  });
}

/**
 * 崩溃注入（SC-010 第一阶段）：进程 stdout 出现 marker 即 SIGKILL，模拟工具执行中崩溃。
 * 只采集与终止，不做任何判定；marker 未出现则超时强杀（调用方按 kind=timeout 报基建错误）。
 */
export function runUntilMarker({ cmd, args, cwd, env, marker, timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, shell: false });
    let stdout = "";
    let stderr = "";
    let done = false;
    let killed = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      if (!done) {
        child.kill("SIGKILL");
        finish({ kind: "timeout", timeoutMs, stdout, stderr });
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (!killed && marker && stdout.includes(marker)) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => finish({ kind: "spawn_error", message: String(e) }));
    child.on("close", (code, signal) => {
      if (done) return;
      finish({ kind: killed ? "killed" : "exited", exitCode: code, signal, stdout, stderr });
    });
  });
}

/**
 * stdin 步骤驱动（repl-script 模式）：steps = [{write: "行"} | {wait: "标记", answer?, withinMs?}]，按序执行。
 * - write 步：写一行，250ms 后继续；
 * - wait 步：轮询 stdout 包含标记后继续；answer = 标记命中后追加写入的一行（供分叉应答）；
 *   withinMs = 等待期限（毫秒），到期未见标记则跳过且不写 answer——用于只有部分实现会出现的
 *   交互分支（如对无效答复的重复询问）。缺省无限等。
 * // ponytail: write 步固定 250ms 间隔、wait 步 100ms 轮询；若某版出现竞态再升级为逐版 prompt 标记
 */
export function runScripted({ cmd, args, cwd, env, steps = [], timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, shell: false });
    let stdout = "";
    let stderr = "";
    let done = false;
    let sawFirst = false;

    const writeLine = (s) => {
      if (child.stdin.writable) child.stdin.write(s + "\n");
    };
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearInterval(poll);
      resolve(payload);
    };
    const runStep = (i) => {
      const step = steps[i];
      if (!step) {
        child.stdin.end();
        return;
      }
      if (step.write !== undefined) {
        writeLine(step.write);
        setTimeout(() => runStep(i + 1), 250);
        return;
      }
      // wait 步：轮询 stdout 包含标记后继续；answer/withinMs 见函数注释
      const started = Date.now();
      poll = setInterval(() => {
        if (stdout.includes(step.wait)) {
          clearInterval(poll);
          if (step.answer !== undefined) writeLine(step.answer);
          setTimeout(() => runStep(i + 1), 250);
        } else if (step.withinMs !== undefined && Date.now() - started >= step.withinMs) {
          clearInterval(poll);
          runStep(i + 1);
        }
      }, 100);
    };
    let poll = null;
    const killTimer = setTimeout(() => {
      if (!done) {
        child.kill();
        finish({ kind: "timeout", timeoutMs });
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (!sawFirst) {
        sawFirst = true;
        setTimeout(() => runStep(0), 400);
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => finish({ kind: "spawn_error", message: String(e) }));
    child.on("close", (code) => finish({ kind: "exited", exitCode: code, stdout, stderr }));
  });
}

/** 场景执行编排：sink → 沙箱+fixtures → 启动 → 采集 + 请求体 + artifact 终态。
 * entry 支持 exec / repl-script / crash-resume（WP7 SC-010：第一阶段跑到 crash_marker 即 SIGKILL，
 * 第二阶段经 adapter.launchResume 携恢复旗标重启，stdin 用 scenario.input.stdin 驱动）。 */
export async function runScenario(adapter, scenario) {
  const sink = await startSink(scenario.input.model_script);
  const { home, env } = sandboxEnv({
    ...adapter.providerEnv(sink),
    ...(adapter.scenarioEnv?.(scenario) ?? {}),
    ...(adapter.extraEnv?.() ?? {}),
  });
  writeFixtures(home, scenario.input.fixtures);
  const launch = adapter.launch(scenario, { home, env, sinkUrl: sink.url });
  let raw;
  if (scenario.input.entry === "exec") {
    raw = await runCapture(launch);
  } else if (scenario.input.entry === "crash-resume") {
    const crash = await runUntilMarker({ ...launch, marker: scenario.input.crash_marker });
    if (crash.kind !== "killed" || typeof adapter.launchResume !== "function") {
      // 崩溃阶段没按剧本死掉（或适配器不支持）：基建错误，不产生行为判定
      await sink.close();
      return {
        kind: `crash_phase_${crash.kind}`,
        message: `crash 阶段 kind=${crash.kind} exit=${crash.exitCode ?? "—"}`,
        stdout: crash.stdout ?? "",
        stderr: crash.stderr ?? "",
      };
    }
    const resume = adapter.launchResume(scenario, { home, env, sinkUrl: sink.url });
    raw = await runScripted({ ...resume, steps: scenario.input.stdin ?? [] });
    raw.crashPhase = { kind: crash.kind, exitCode: crash.exitCode, stdoutHead: crash.stdout.slice(-300) };
  } else {
    raw = await runScripted({ ...launch, steps: scenario.input.stdin ?? [] });
  }
  raw.providerRequests = sink.count();
  raw.bodies = sink.bodies();
  raw.requestStats = sink.stats();
  raw.artifactContents = readFixtures(home, scenario.input.fixtures);
  await sink.close();
  return raw;
}
