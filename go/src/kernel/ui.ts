// 终端着色与截断：零依赖 ANSI，仅在 TTY 上着色（重定向/冒烟测试输出保持干净）。
// 放 kernel：core 与 plugins 两层都要用，属共享工具。
const tty = process.stdout.isTTY;

const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: wrap('2'),
  cyan: wrap('36'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  bold: wrap('1'),
};

/** 超长文本截断，末尾标注省略了多少字符 */
export function ellipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断，省略 ${s.length - max} 字符）`;
}
