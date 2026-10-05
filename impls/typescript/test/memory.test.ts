// 长期记忆最小闭环：memory.md 注入系统提示词 + /memory 斜杠命令（查看/追加/清空）。
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSystemPrompt } from '../src/core/systemprompt.ts';
import { Registry } from '../src/kernel/registry.ts';
import { builtinPlugins } from '../src/plugins/index.ts';
import type { App } from '../src/kernel/app.ts';

function setup(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-memory-'));
  const registry = new Registry().registerAll(builtinPlugins);
  const app = { config: { tcodeDir: dir }, registry } as unknown as App;
  const memoryFile = path.join(dir, 'memory.md');
  t.after(() => { try { if (existsSync(memoryFile)) unlinkSync(memoryFile); } catch {} });
  return { dir, registry, app, memoryFile };
}

test('数据目录 memory.md 注入系统提示词', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-mem-'));
  writeFileSync(path.join(dir, 'memory.md'), '- 用户偏好简短回答\n- 项目用 pnpm');
  const prompt = buildSystemPrompt('/tmp/whatever', dir, dir);
  assert.match(prompt, /# 长期记忆/);
  assert.match(prompt, /- 用户偏好简短回答/);
  assert.match(prompt, /- 项目用 pnpm/);
});

test('memory.md 不存在时不注入记忆段', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-mem-'));
  const prompt = buildSystemPrompt('/tmp/whatever', dir, dir);
  assert.equal(prompt.includes('# 长期记忆'), false);
});

test('/memory 查看为空提示，追加后文件真实写入并可见', async (t) => {
  const { registry, app, memoryFile } = setup(t);
  const memory = registry.commands().find((cmd) => cmd.name === 'memory');
  assert.ok(memory, '/memory 命令必须注册');
  const logs: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
  try {
    await memory.run(app, []);
    assert.match(logs.join('\n'), /长期记忆为空|为空/);
    await memory.run(app, ['用户偏好简短回答']);
    assert.equal(existsSync(memoryFile), true, '追加必须真实写文件');
    assert.match(readFileSync(memoryFile, 'utf8'), /用户偏好简短回答/);
    logs.length = 0;
    await memory.run(app, []);
    assert.match(logs.join('\n'), /用户偏好简短回答/, '查看显示已追加内容');
  } finally {
    console.log = original;
  }
});

test('/memory clear 清空记忆', async (t) => {
  const { registry, app, memoryFile } = setup(t);
  writeFileSync(memoryFile, '- 旧记忆\n');
  const memory = registry.commands().find((cmd) => cmd.name === 'memory');
  await memory!.run(app, ['clear']);
  assert.equal(existsSync(memoryFile), false, 'clear 后文件删除');
});
