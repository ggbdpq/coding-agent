// pcode 适配器：解释执行，无构建产物。PYTHONPATH 指向实现目录，cwd 统一沙箱 HOME
// （工具相对路径必须落在沙箱内）。
import { join } from "node:path";
import { IMPLS } from "./shared.mjs";

const yolo = (scenario) => (scenario.input.approval === "yolo" ? ["--yolo"] : []);

export default {
  name: "pcode",
  async prepare() {
    return { ok: true, kind: "interpreted", note: "python -m 直跑源码" };
  },
  providerEnv(sink) {
    return { PCODE_API_KEY: "test-key", PCODE_BASE_URL: sink.url, PCODE_MODEL: "fake-model" };
  },
  launch(scenario, { home, env }) {
    env.PYTHONPATH = join(IMPLS, "python");
    return scenario.input.entry === "exec"
      ? { cmd: "python", args: ["-m", "pcode", ...yolo(scenario), "exec", scenario.input.task], cwd: home, env }
      : { cmd: "python", args: ["-m", "pcode", ...yolo(scenario)], cwd: home, env };
  },
};
