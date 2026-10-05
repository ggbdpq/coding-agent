// 会话工作目录注入：不同会话工作目录下同一相对路径解析到各自目录。
// resolvePath/isWriteTrusted 的基准从进程 cwd 切换为显式注入的会话 cwd；
// 未注入（null）时回落 process.cwd()，保持既有行为不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolvePath, isWriteTrusted, setSessionCwd } from '../src/plugins/tools/pathguard.ts';

function ws(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'tcode-cwd-')), name);
}

test('setSessionCwd 后相对路径解析到各自会话目录', () => {
  const a = ws('a'), b = ws('b');
  setSessionCwd(a);
  assert.equal(resolvePath('task.txt').abs, path.join(a, 'task.txt'));
  assert.equal(resolvePath('task.txt').outside, false);
  setSessionCwd(b);
  assert.equal(resolvePath('task.txt').abs, path.join(b, 'task.txt'));
});

test('会话目录外的相对穿越仍标注 outside', () => {
  const deep = ws('deep');
  setSessionCwd(deep);
  const resolved = resolvePath('../escape.txt');
  assert.equal(resolved.outside, true);
  assert.equal(resolved.abs, path.resolve(deep, '..', 'escape.txt'));
});

test('绝对路径不受会话目录影响', () => {
  const target = ws('absolute');
  setSessionCwd(ws('somewhere'));
  assert.equal(resolvePath(target).abs, path.resolve(target));
});

test('白名单相对基准跟随会话目录，会话目录外仍不受信', () => {
  const trustedDir = ws('trusted');
  setSessionCwd(trustedDir);
  assert.equal(isWriteTrusted('result.txt', [trustedDir]), true, '会话目录内的相对写入受信');
  assert.equal(isWriteTrusted('../outside.txt', [trustedDir]), false, '会话目录外的写入不受信');
});

test('setSessionCwd(null) 回落进程 cwd，行为与旧版一致', () => {
  setSessionCwd(null);
  const expected = path.resolve('from-cwd.txt');
  assert.equal(resolvePath('from-cwd.txt').abs, expected);
});

test('bash 工具的执行目录跟随会话工作目录', async () => {
  const { execFileSync } = await import('node:child_process');
  // 编译 bash 工具并直接调用其 run（走真实 spawn）
  const { default: bashPlugin } = await import('../src/plugins/tools/bash.ts');
  const sessionDir = ws('bash-session');
  mkdirSync(sessionDir, { recursive: true });
  setSessionCwd(sessionDir);
  const output = await (bashPlugin.run as (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>)({ command: 'pwd' });
  assert.match(String(output), new RegExp(sessionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'bash 的 pwd 应为会话工作目录');
  setSessionCwd(null);
  const fallback = await (bashPlugin.run as (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>)({ command: 'pwd' });
  assert.doesNotMatch(String(fallback), /tcode-cwd-/, '回落后不再使用上一会话目录');
  void execFileSync;
});
