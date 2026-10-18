// gcode 适配器：go build 到 conformance/.artifacts/（不入 impls/），跑前过新鲜度门。
import { join } from "node:path";
import { ARTIFACTS, IMPLS, ensureFresh } from "./shared.mjs";

const exe = process.platform === "win32" ? "gcode.exe" : "gcode";
const bin = join(ARTIFACTS, exe);
const yolo = (scenario) => (scenario.input.approval === "yolo" ? ["--yolo"] : []);
const execLike = (scenario) => scenario.input.entry === "exec" || scenario.input.entry === "crash-resume";

export default {
  name: "gcode",
  async prepare() {
    return ensureFresh({
      label: "gcode",
      binPath: bin,
      sourceDirs: [join(IMPLS, "go")],
      sourceExts: [".go"],
      build: { cmd: "go", args: ["build", "-o", bin, "./cmd/gcode"], cwd: join(IMPLS, "go") },
    });
  },
  providerEnv(sink) {
    return { GCODE_API_KEY: "test-key", GCODE_BASE_URL: sink.url, GCODE_MODEL: "fake-model" };
  },
  scenarioEnv(scenario) {
    const n = scenario.input.context_limit;
    return n ? { GCODE_CONTEXT_LIMIT: String(n) } : {};
  },
  launch(scenario, { home, env }) {
    return execLike(scenario)
      ? { cmd: bin, args: ["exec", ...yolo(scenario), scenario.input.task], cwd: home, env }
      : { cmd: bin, args: yolo(scenario), cwd: home, env };
  },
  // crash-resume 第二阶段：恢复旗标是五版统一入口契约（session-turn R7 --continue）
  launchResume(scenario, { home, env }) {
    return { cmd: bin, args: ["--continue", ...yolo(scenario)], cwd: home, env };
  },
};
