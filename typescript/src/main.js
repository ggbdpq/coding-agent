// 入口：装配——注册内置插件 → 创建 App → 起 shell（repl/web）或 headless(exec)。
// 缺配置给中文指路，不甩堆栈。
import path from 'node:path';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { loadConfig } from './kernel/config.ts';
import { Registry } from './kernel/registry.ts';
import { createApp, VERSION } from './kernel/app.ts';
import { builtinPlugins } from './plugins/index.ts';
import { buildSystemPrompt } from './core/systemprompt.ts';
import { runUserTurn } from './core/turn.ts';
import { expandAtRefs } from './core/atrefs.ts';
import { SessionStore } from './core/session.ts';
const USAGE = [
    'tcode —— 极简本地优先 coding agent',
    '',
    '用法：tcode [exec "任务"] [web] [--continue] [--yolo] [--approval normal|never] [--help] [--version]',
    '',
    '  exec "任务"  无交互执行单个任务后退出（CI/脚本用；必须配合 --yolo）',
    '  web          启动浏览器版（本地服务，打印地址后用浏览器打开）',
    '  --continue   启动时恢复最近一次会话',
    '  --yolo       跳过写文件/执行命令的逐次确认（会话内可用 /yolo 切换）',
    '  --help       显示本帮助',
    '  --version    显示版本',
    '',
    '环境变量：TCODE_API_KEY / TCODE_BASE_URL / TCODE_MODEL / TCODE_PROTOCOL / TCODE_APPROVAL',
    '          （或写 ~/.tcode/config.json）',
].join('\n');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
}
if (args.includes('--version')) {
    console.log(`tcode v${VERSION}`);
    process.exit(0);
}
// 参数规整：--approval 的值不落入位置参数
const clean = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--approval') {
        const v = args[i + 1];
        if (v !== undefined && !v.startsWith('--'))
            i++;
        continue;
    }
    clean.push(args[i]);
}
const yolo = clean.includes('--yolo');
const cont = clean.includes('--continue');
const extra = clean.filter((a) => !a.startsWith('--'));
const shellName = extra[0] === 'web' || extra[0] === 'exec' ? extra[0] : 'repl';
const rest = extra.slice(shellName === 'repl' ? 0 : 1);
if (rest.length > 0) {
    console.log(`提示：忽略多余参数：${rest.join(' ')}`);
}
/** 供 @引用 读取的封顶读文件（1MB 内全读，超出截断） */
function cappedRead(p) {
    try {
        const abs = path.resolve(p);
        const st = statSync(abs);
        if (st.isDirectory())
            return null;
        const fd = openSync(abs, 'r');
        const buf = Buffer.alloc(Math.min(st.size, 1024 * 1024));
        const n = readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        return buf.toString('utf8', 0, n);
    }
    catch {
        return null;
    }
}
try {
    const config = loadConfig();
    const registry = new Registry().registerAll(builtinPlugins);
    const app = createApp(config, registry, {
        yolo: yolo || (config.approval === 'never'),
        freshMessages: () => [{ role: 'system', content: buildSystemPrompt(process.cwd()) }],
        store: new SessionStore(path.join(config.tcodeDir, 'sessions')),
    });
    if (cont) {
        const latest = app.store.listRecent(1)[0];
        if (latest) {
            const loaded = app.store.load(latest.file).filter((m) => m.role !== 'system');
            app.messages.push(...loaded);
            app.startSession({ resumedFrom: path.basename(latest.file) });
            console.log(`已恢复最近会话（${loaded.length} 条消息）。`);
        }
        else {
            console.log('没有可恢复的会话，从新会话开始。');
        }
    }
    if (shellName === 'exec') {
        if (!app.yolo.value) {
            throw new Error('exec 模式必须配合 --yolo（无交互环境无法逐次确认写操作）');
        }
        const task = expandAtRefs(rest.join(' ').trim(), cappedRead);
        if (!task)
            throw new Error('exec 需要任务描述：tcode exec "任务"');
        let failed = false;
        try {
            await runUserTurn(app, task, {
                emit: (ev) => {
                    switch (ev.type) {
                        case 'text_delta':
                            process.stdout.write(ev.delta);
                            break;
                        case 'tool_call':
                            console.log(`\n[tool] ${ev.name} ${JSON.stringify(ev.args).slice(0, 160)}`);
                            break;
                        case 'tool_result':
                            console.log(`[result] ${ev.summary.split('\n')[0]} (${ev.ms}ms)`);
                            break;
                        case 'turn_end':
                            if (ev.reason !== 'completed') {
                                console.error(`\n[turn:${ev.reason}]${ev.error ?? ''}`);
                                failed = true;
                            }
                            break;
                        default:
                            break;
                    }
                },
            });
            process.stdout.write('\n');
        }
        catch (e) {
            console.error(`错误：${e.message}`);
            failed = true;
        }
        process.exitCode = failed ? 1 : 0;
    }
    else {
        const shell = registry.shell(shellName);
        if (!shell)
            throw new Error(`找不到 shell 插件：${shellName}`);
        await shell.start(app);
    }
}
catch (e) {
    console.error(`启动失败：${e.message}`);
    process.exit(1);
}
