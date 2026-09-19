// apply_patch 原子补丁单测：全预验通过才写入；任一失败零写入并逐条报告。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import applyPatchTool from '../src/plugins/tools/apply_patch.ts';

function setup(): { dir: string; a: string; b: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'patch-'));
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  writeFileSync(a, 'alpha\nbeta\n');
  writeFileSync(b, 'hello\n');
  return { dir, a, b };
}

test('全部预验通过：多文件一次应用', async () => {
  const { a, b } = setup();
  const result = await applyPatchTool.run({
    edits: [
      { file_path: a, old_string: 'alpha', new_string: 'ALPHA' },
      { file_path: b, old_string: 'hello', new_string: 'HELLO' },
    ],
  });
  assert.match(result, /已应用补丁：2 处编辑/);
  assert.equal(readFileSync(a, 'utf8'), 'ALPHA\nbeta\n');
  assert.equal(readFileSync(b, 'utf8'), 'HELLO\n');
});

test('任一失败：零写入并逐条报告', async () => {
  const { a, b } = setup();
  const result = await applyPatchTool.run({
    edits: [
      { file_path: a, old_string: 'alpha', new_string: 'ALPHA' },
      { file_path: b, old_string: '不存在的原文', new_string: 'X' },
    ],
  });
  assert.match(result, /预验未通过/);
  assert.match(result, /未找到 old_string/);
  assert.equal(readFileSync(a, 'utf8'), 'alpha\nbeta\n', '失败时 a 不应被改动');
  assert.equal(readFileSync(b, 'utf8'), 'hello\n');
});

test('多处出现未指定 replace_all：拒绝该条', async () => {
  const { a } = setup();
  const result = await applyPatchTool.run({
    edits: [{ file_path: a, old_string: 'a', new_string: 'A' }],
  });
  assert.match(result, /出现 3 次/);
  assert.equal(readFileSync(a, 'utf8'), 'alpha\nbeta\n');
});
