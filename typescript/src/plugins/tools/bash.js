// bash 工具：子进程执行命令，输出封顶、超时强杀。
// win32 优先用 Git Bash（模型常发 unix 命令），只认显式路径，避免误中 System32 的 WSL bash；
// 都没有就退回 cmd。安全边界：执行前经权限确认，确认界面展示完整命令。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { definePlugin } from '../../kernel/plugin.ts';
const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;
function resolveShell() {
    if (process.platform === 'win32') {
        const candidates = [process.env.TCODE_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe'].filter(Boolean);
        for (const b of candidates) {
            if (existsSync(b))
                return { file: b, args: ['-c'] };
        }
        return { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c'] };
    }
    return { file: '/bin/bash', args: ['-c'] };
}
export default definePlugin({
    name: 'bash',
    kind: 'tool',
    description: '在当前目录执行 shell 命令并返回退出码与输出。用于跑测试、构建、git 等验证操作；输出超长会被截断。',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: '要执行的命令' },
            timeout_sec: {
                type: 'number',
                description: `超时秒数，默认 ${DEFAULT_TIMEOUT_SEC}，上限 ${MAX_TIMEOUT_SEC}`,
            },
        },
        required: ['command'],
    },
    needsPermission: true,
    preview: (a) => `执行命令（cwd=${process.cwd()}）\n$ ${String(a.command ?? '')}`,
    async run(args, signal) {
        const command = String(args.command ?? '');
        if (!command.trim())
            return '错误：缺少 command';
        const timeoutSec = Math.max(1, Math.min(Number(args.timeout_sec ?? DEFAULT_TIMEOUT_SEC), MAX_TIMEOUT_SEC));
        const { file, args: shellArgs } = resolveShell();
        return await new Promise((resolve) => {
            const child = spawn(file, [...shellArgs, command], {
                cwd: process.cwd(),
                windowsHide: true,
            });
            let out = '';
            let err = '';
            let killed = false; // 超时终止
            let aborted = false; // 用户中止终止
            const timer = setTimeout(() => {
                killed = true;
                if (process.platform === 'win32' && child.pid) {
                    // Windows 上 kill 杀不掉子进程树，用 taskkill 连坐
                    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
                }
                else {
                    child.kill('SIGKILL');
                }
            }, timeoutSec * 1000);
            // 用户中止：杀 bash 本体即可让本轮结束；其孙进程为 sleep 类有限命令，自然退出
            // （ponytail: 树杀升级等真实泄漏出现再做）
            if (signal) {
                const abortKill = () => {
                    aborted = true;
                    child.kill('SIGKILL');
                };
                if (signal.aborted)
                    abortKill();
                else
                    signal.addEventListener('abort', abortKill, { once: true });
            }
            child.stdout.on('data', (d) => {
                if (out.length < MAX_OUTPUT)
                    out += d.toString();
            });
            child.stderr.on('data', (d) => {
                if (err.length < MAX_OUTPUT)
                    err += d.toString();
            });
            child.on('error', (e) => {
                clearTimeout(timer);
                resolve(`错误：无法启动 shell（${e.message}）`);
            });
            let settled = false;
            const finish = (parts) => {
                if (settled)
                    return;
                settled = true;
                resolve(parts.join('\n'));
            };
            // 用户中止杀掉 bash 后，孤儿孙进程仍握着管道，close 会迟到——exit 立即收
            child.on('exit', (code, exitSignal) => {
                if (!aborted)
                    return;
                const parts = [`exit=aborted（用户中止）`];
                if (out.trim())
                    parts.push(`--- stdout ---\n${out.trimEnd()}`);
                if (err.trim())
                    parts.push(`--- stderr ---\n${err.trimEnd()}`);
                finish(parts);
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                const cap = (s) => s.length >= MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（输出超长已截断）` : s;
                const exitText = aborted
                    ? 'aborted（用户中止）'
                    : killed
                        ? `timeout（${timeoutSec}s 超时强制终止）`
                        : (code ?? `signal:${signal}`);
                const parts = [`exit=${exitText}`];
                if (out.trim())
                    parts.push(`--- stdout ---\n${cap(out).trimEnd()}`);
                if (err.trim())
                    parts.push(`--- stderr ---\n${cap(err).trimEnd()}`);
                finish(parts);
            });
        });
    },
});
