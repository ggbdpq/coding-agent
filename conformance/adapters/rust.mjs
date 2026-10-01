// rcode 适配器：cargo build 后直接执行产物（区别于自有冒烟的 CARGO_BIN_EXE 编译期路径，
// 此处运行时定位 + 源码-产物新鲜度比对，即 lessons L1 的落点）。
import { join } from "node:path";
import { IMPLS, ensureFresh } from "./shared.mjs";

const exe = process.platform === "win32" ? "rcode.exe" : "rcode";
const bin = join(IMPLS, "rust", "target", "debug", exe);
const yolo = (scenario) => (scenario.input.approval === "yolo" ? ["--yolo"] : []);

export default {
  name: "rcode",
  async prepare() {
    return ensureFresh({
      label: "rcode",
      binPath: bin,
      sourceDirs: [join(IMPLS, "rust", "src")],
      sourceExts: [".rs", ".toml"],
      build: { cmd: "cargo", args: ["build"], cwd: join(IMPLS, "rust") },
    });
  },
  providerEnv(sink) {
    return { RCODE_API_KEY: "test-key", RCODE_BASE_URL: sink.url, RCODE_MODEL: "fake-model" };
  },
  launch(scenario, { home, env }) {
    return scenario.input.entry === "exec"
      ? { cmd: bin, args: ["exec", ...yolo(scenario), scenario.input.task], cwd: home, env }
      : { cmd: bin, args: yolo(scenario), cwd: home, env };
  },
};
