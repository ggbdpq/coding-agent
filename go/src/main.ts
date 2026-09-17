// 入口：装配——注册内置插件 → 创建 App → 起 shell。缺配置给中文指路，不甩堆栈。
import path from 'node:path';
import { loadConfig } from './kernel/config.ts';
import { Registry } from './kernel/registry.ts';
import { createApp, VERSION } from './kernel/app.ts';
import { builtinPlugins } from './plugins/index.ts';
import { buildSystemPrompt } from './core/systemprompt.ts';
import { SessionStore } from './core/session.ts';

const USAGE = [
  'gcode —— 极简本地优先 coding agent',
  '',
  '用法：gcode [web] [--yolo] [--help] [--version]',
  '',
  '  web        启动浏览器版（本地服务，打印地址后用浏览器打开）',
  '  --yolo     跳过写文件/执行命令的逐次确认（会话内可用 /yolo 切换）',
  '  --help     显示本帮助',
  '  --version  显示版本',
  '',
  '环境变量：GCODE_API_KEY / GCODE_BASE_URL / GCODE_MODEL / GCODE_PROTOCOL（或写 ~/.gcode/config.json）',
].join('\n');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (args.includes('--version')) {
  console.log(`gcode v${VERSION}`);
  process.exit(0);
}
const yolo = args.includes('--yolo');
const extra = args.filter((a) => !a.startsWith('--'));
const shellName = extra[0] === 'web' ? 'web' : 'repl';
const rest = extra.slice(shellName === 'web' ? 1 : 0);
if (rest.length > 0) {
  console.log(`提示：gcode 目前只支持交互式使用，忽略多余参数：${rest.join(' ')}`);
}

try {
  const config = loadConfig();
  const registry = new Registry().registerAll(builtinPlugins);
  const app = createApp(config, registry, {
    yolo,
    freshMessages: () => [{ role: 'system', content: buildSystemPrompt(process.cwd()) }],
    store: new SessionStore(path.join(config.gcodeDir, 'sessions')),
  });
  const shell = registry.shell(shellName);
  if (!shell) throw new Error(`找不到 shell 插件：${shellName}`);
  await shell.start(app);
} catch (e) {
  console.error(`启动失败：${(e as Error).message}`);
  process.exit(1);
}
