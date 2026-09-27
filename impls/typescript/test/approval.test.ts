// 审批策略与写白名单单测：config.allowWriteDirs 内的写操作免确认，外必问。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import writeTool from '../src/plugins/tools/write.ts';
import editTool from '../src/plugins/tools/edit.ts';
import type { App } from '../src/kernel/app.ts';

function fakeApp(allowWriteDirs?: string[]): App {
  return {
    config: {
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1',
      model: 'fake',
      contextLimit: 1_000_000,
      tcodeDir: '/tmp',
      ...(allowWriteDirs ? { allowWriteDirs } : {}),
    },
    registry: new (class {})() as never,
    provider: {} as never,
    store: {} as never,
    yolo: { value: false },
    planMode: { value: false },
    messages: [],
    startSession() {},
    resetMessages() {},
  };
}

const cwd = process.cwd();

test('write：路径在白名单目录内 → 免确认', () => {
  const app = fakeApp([path.join(cwd, 'build')]);
  const target = path.join(cwd, 'build', 'out.txt');
  assert.equal(writeTool.skipPermission?.({ file_path: target }, app), true);
});

test('write：路径在白名单外 → 仍需确认', () => {
  const app = fakeApp([path.join(cwd, 'build')]);
  const target = path.join(cwd, 'src', 'out.txt');
  assert.equal(writeTool.skipPermission?.({ file_path: target }, app) ?? false, false);
});

test('未配置白名单 → 一律确认（含 write）', () => {
  const app = fakeApp();
  const target = path.join(cwd, 'whatever.txt');
  assert.equal(writeTool.skipPermission?.({ file_path: target }, app) ?? false, false);
});

test('edit：白名单内免确认', () => {
  const app = fakeApp([cwd]);
  assert.equal(editTool.skipPermission?.({ file_path: path.join(cwd, 'a.ts') }, app), true);
});
