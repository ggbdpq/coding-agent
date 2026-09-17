// rg 工具函数：glob/grep 两个工具共用。约定退出码：0 有匹配、1 无匹配、≥2 出错。
import { spawn } from 'node:child_process';

export function runRg(rgArgs: string[], cap = 8000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('rg', rgArgs, { cwd: process.cwd(), windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < cap + 1000) out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) =>
      resolve(`错误：无法启动 rg（${e.message}）。本工具依赖 ripgrep，请先安装。`)
    );
    child.on('close', (code) => {
      if (code === 1 && !err.trim()) {
        resolve('无匹配');
        return;
      }
      if (code !== null && code > 1) {
        resolve(`错误：rg 退出码 ${code}：${err.trim().slice(0, 500)}`);
        return;
      }
      if (out.length > cap) out = `${out.slice(0, cap)}\n…（结果超长已截断）`;
      resolve(out.trimEnd() || '无匹配');
    });
  });
}
