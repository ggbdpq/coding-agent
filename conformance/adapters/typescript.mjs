// tcode 适配器：解释执行，无构建产物（新鲜度门以"解释型"通过）。
import { join } from "node:path";
import { IMPLS } from "./shared.mjs";

const bin = join(IMPLS, "typescript", "bin", "tcode.js");
const yolo = (scenario) => (scenario.input.approval === "yolo" ? ["--yolo"] : []);
const execLike = (scenario) => scenario.input.entry === "exec" || scenario.input.entry === "crash-resume";

export default {
  name: "tcode",
  async prepare() {
    return { ok: true, kind: "interpreted", note: "Node 直跑源码，无产物陈旧问题" };
  },
  providerEnv(sink) {
    return { TCODE_API_KEY: "test-key", TCODE_BASE_URL: sink.url, TCODE_MODEL: "fake-model" };
  },
  // 场景声明的逻辑配置 → 实现环境变量（context_limit / max_tool_rounds 是 spec 字段，非实现词）
  scenarioEnv(scenario) {
    const n = scenario.input.context_limit;
    const rounds = scenario.input.max_tool_rounds;
    return {
      ...(n ? { TCODE_CONTEXT_LIMIT: String(n) } : {}),
      ...(rounds ? { TCODE_MAX_TOOL_ROUNDS: String(rounds) } : {}),
    };
  },
  launch(scenario, { home, env }) {
    // 工具相对路径必须落在沙箱 HOME：cwd 统一为 home
    return execLike(scenario)
      ? { cmd: process.execPath, args: [bin, "exec", ...yolo(scenario), scenario.input.task], cwd: home, env }
      : { cmd: process.execPath, args: [bin, ...yolo(scenario)], cwd: home, env };
  },
  // crash-resume 第二阶段：恢复旗标是五版统一入口契约（session-turn R7 --continue）
  launchResume(scenario, { home, env }) {
    return { cmd: process.execPath, args: [bin, "--continue", ...yolo(scenario)], cwd: home, env };
  },
};
