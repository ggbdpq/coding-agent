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

/** OpenAI 线格式编码：逻辑响应步 → SSE 帧（tool_calls 一帧整发，分片考验留在各版自有冒烟）。 */
function encodeOpenaiSse(step) {
  const frames = [];
  if (step.tool_call) {
    frames.push({ choices: [{ delta: { role: "assistant" } }] });
    frames.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: step.tool_call.name, arguments: JSON.stringify(step.tool_call.arguments) },
          }],
        },
      }],
    });
    frames.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  } else {
    const text = step.text ?? step.final?.text ?? "";
    const mid = Math.max(1, Math.ceil(text.length / 2));
    frames.push({ choices: [{ delta: { role: "assistant" } }] });
    frames.push({ choices: [{ delta: { content: text.slice(0, mid) } }] });
    frames.push({ choices: [{ delta: { content: text.slice(mid) } }] });
    frames.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
  }
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * 假 provider：记录每个请求体（S1 通道），按「最后一条消息 role」路由剧本。
 * - model_script = { kind: "tool-then-text", tool, final_text }：user→工具调用，tool→final 文本；
 * - 无剧本（SC-004 类）：只计数 + 500——收到请求即漂移证据。
 */
export function startSink(modelScript) {
  const scripted = modelScript?.kind === "tool-then-text";
  let count = 0;
  const bodies = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      count += 1;
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {}
      if (body) bodies.push(body);
      const lastRole = scripted ? body?.messages?.at(-1)?.role : null;
      const sse =
        scripted && lastRole === "user"
          ? encodeOpenaiSse({ tool_call: modelScript.tool })
          : scripted && lastRole === "tool"
            ? encodeOpenaiSse({ text: modelScript.final_text })
            : null;
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
 * stdin 步骤驱动（repl-script 模式）：steps = [{write: "行"} | {wait: "标记"}]，按序执行。
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
      // wait 步：轮询 stdout 包含标记后继续
      poll = setInterval(() => {
        if (stdout.includes(step.wait)) {
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

/** 场景执行编排：sink → 沙箱+fixtures → 启动 → 采集 + 请求体 + artifact 终态。 */
export async function runScenario(adapter, scenario) {
  const sink = await startSink(scenario.input.model_script);
  const { home, env } = sandboxEnv({
    ...adapter.providerEnv(sink),
    ...(adapter.extraEnv?.() ?? {}),
  });
  writeFixtures(home, scenario.input.fixtures);
  const launch = adapter.launch(scenario, { home, env, sinkUrl: sink.url });
  let raw;
  if (scenario.input.entry === "exec") {
    raw = await runCapture(launch);
  } else {
    raw = await runScripted({ ...launch, steps: scenario.input.stdin ?? [] });
  }
  raw.providerRequests = sink.count();
  raw.bodies = sink.bodies();
  raw.artifactContents = readFixtures(home, scenario.input.fixtures);
  await sink.close();
  return raw;
}
