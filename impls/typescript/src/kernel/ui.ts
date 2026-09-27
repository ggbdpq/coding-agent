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

/**
 * 旧文本 → 新文本的简易行级 diff 预览（前缀 +/-，保留两侧公共首尾行减少噪音）。
 * ponytail: 不做 LCS 最小 diff——确认预览要的是"改了什么"而非"最短编辑脚本"；
 * 需要精确 diff 时升级为独立渲染器。
 */
export function previewDiff(oldText: string, newText: string, maxLines = 40): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  // 公共前缀/后缀
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (
    suf < oldLines.length - pre &&
    suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  )
    suf++;
  const removed = oldLines.slice(pre, oldLines.length - suf).map((l) => `-${l}`);
  const added = newLines.slice(pre, newLines.length - suf).map((l) => `+${l}`);
  const ctxBefore = oldLines.slice(Math.max(0, pre - 2), pre).map((l) => ` ${l}`);
  const ctxAfter = newLines.slice(newLines.length - suf, newLines.length - suf + 2).map((l) => ` ${l}`);
  const lines = [...ctxBefore, ...removed, ...added, ...ctxAfter];
  const body = lines.slice(0, maxLines).join('\n');
  return lines.length > maxLines ? `${body}\n…（diff 共 ${lines.length} 行，已截断）` : body;
}
