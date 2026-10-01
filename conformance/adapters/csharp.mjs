// ccode 适配器：dotnet build 主工程（tests 由 csproj 剔除），执行 apphost 产物。
// 环境前提（L2）：apphost 在自定义安装位找不到运行时，必须显式 DOTNET_ROOT。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { IMPLS, ensureFresh } from "./shared.mjs";

const exe = process.platform === "win32" ? "ccode.exe" : "ccode";
const bin = join(IMPLS, "csharp", "bin", "Debug", "net8.0", exe);
const yolo = (scenario) => (scenario.input.approval === "yolo" ? ["--yolo"] : []);

let cachedRoot;
function dotnetRoot() {
  if (cachedRoot !== undefined) return cachedRoot;
  const r = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["dotnet"], { encoding: "utf8" });
  const first = (r.stdout ?? "").split(/\r?\n/).find(Boolean)?.trim();
  cachedRoot = first ? dirname(first) : "";
  return cachedRoot;
}

export default {
  name: "ccode",
  async prepare() {
    return ensureFresh({
      label: "ccode",
      binPath: bin,
      sourceDirs: [join(IMPLS, "csharp")],
      sourceExts: [".cs"],
      build: { cmd: "dotnet", args: ["build", "ccode.csproj"], cwd: join(IMPLS, "csharp") },
    });
  },
  providerEnv(sink) {
    return { CCODE_API_KEY: "test-key", CCODE_BASE_URL: sink.url, CCODE_MODEL: "fake-model" };
  },
  extraEnv() {
    return dotnetRoot() ? { DOTNET_ROOT: dotnetRoot() } : {};
  },
  launch(scenario, { home, env }) {
    return scenario.input.entry === "exec"
      ? { cmd: bin, args: ["exec", ...yolo(scenario), scenario.input.task], cwd: home, env }
      : { cmd: bin, args: yolo(scenario), cwd: home, env };
  },
};
