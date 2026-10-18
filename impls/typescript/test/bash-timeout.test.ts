import test from 'node:test';
import assert from 'node:assert/strict';
import bashTool from '../src/plugins/tools/bash.ts';

test('bash 工具：超时连同后台孙进程一起终止并及时返回', { skip: process.platform === 'win32' }, async () => {
  const start = Date.now();
  const out = await bashTool.run({ command: 'sleep 5 & wait', timeout_sec: 1 }, undefined);
  assert.match(String(out), /^exit=timeout/);
  assert.ok(Date.now() - start < 3000, `耗时 ${Date.now() - start}ms`);
});
