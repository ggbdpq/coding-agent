// bash 工具：子进程执行命令，输出封顶、超时强杀。
// win32 优先用 Git Bash（模型常发 unix 命令），只认显式路径，避免误中 System32 的 WSL bash；
// 都没有就退回 cmd。安全边界：执行前经权限确认，确认界面展示完整命令。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { definePlugin } from '../../kernel/plugin.ts';

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;

interface ShellCmd {
  file: string;
  args: string[];
}

function resolveShell(): ShellCmd {
  if (process.platform === 'win32') {
    const candidates = [process.env.GCODE_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe'].filter(
      Boolean
    ) as string[];
    for (const b of candidates) {
      if (existsSync(b)) return { file: b, args: ['-c'] };
    }
    return { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c'] };
  }
  return { file: '/bin/bash', args: ['-c'] };
}

export default definePlugin({
  name: 'bash',
  kind: 'tool',
  description:
    '在当前目录执行 shell 命令并返回退出码与输出。用于跑测试、构建、git 等验证操作；输出超长会被截断。',
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
  async run(args) {
    const command = String(args.command ?? '');
    if (!command.trim()) return '错误：缺少 command';
    const timeoutSec = Math.max(
      1,
      Math.min(Number(args.timeout_sec ?? DEFAULT_TIMEOUT_SEC), MAX_TIMEOUT_SEC)
    );
    const { file, args: shellArgs } = resolveShell();

    return await new Promise<string>((resolve) => {
      const child = spawn(file, [...shellArgs, command], {
        cwd: process.cwd(),
        windowsHide: true,
      });
      let out = '';
      let err = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        if (process.platform === 'win32' && child.pid) {
          // Windows 上 kill 杀不掉子进程树，用 taskkill 连坐
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      }, timeoutSec * 1000);

      child.stdout.on('data', (d: Buffer) => {
        if (out.length < MAX_OUTPUT) out += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        if (err.length < MAX_OUTPUT) err += d.toString();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve(`错误：无法启动 shell（${e.message}）`);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const cap = (s: string) =>
          s.length >= MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（输出超长已截断）` : s;
        const parts = [
          `exit=${killed ? `timeout（${timeoutSec}s 超时强制终止）` : (code ?? `signal:${signal}`)}`,
        ];
        if (out.trim()) parts.push(`--- stdout ---\n${cap(out).trimEnd()}`);
        if (err.trim()) parts.push(`--- stderr ---\n${cap(err).trimEnd()}`);
        resolve(parts.join('\n'));
      });
    });
  },
});
