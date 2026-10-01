// tcode 适配器：解释执行，无构建产物（新鲜度门以"解释型"通过）。
import { join } from "node:path";
import { IMPLS } from "./shared.mjs";

const bin = join(IMPLS, "typescript", "bin", "tcode.js");
const yolo = (scenario) => (scenario.input.approval === "yolo" ? ["--yolo"] : []);

export default {
  name: "tcode",
  async prepare() {
    return { ok: true, kind: "interpreted", note: "Node 直跑源码，无产物陈旧问题" };
  },
  providerEnv(sink) {
    return { TCODE_API_KEY: "test-key", TCODE_BASE_URL: sink.url, TCODE_MODEL: "fake-model" };
  },
  launch(scenario, { home, env }) {
    // 工具相对路径必须落在沙箱 HOME：cwd 统一为 home
    return scenario.input.entry === "exec"
      ? { cmd: process.execPath, args: [bin, "exec", ...yolo(scenario), scenario.input.task], cwd: home, env }
      : { cmd: process.execPath, args: [bin, ...yolo(scenario)], cwd: home, env };
  },
};
