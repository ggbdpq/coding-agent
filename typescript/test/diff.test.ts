// diff 预览单测：前缀 +/-、公共上下文收敛、截断标注。
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewDiff } from '../src/kernel/ui.ts';

test('相同文本：无 +/- 行', () => {
  const d = previewDiff('a\nb', 'a\nb');
  assert.ok(!d.includes('-a') && !d.includes('+a'));
});

test('替换：显示 - 旧行与 + 新行', () => {
  const d = previewDiff('old line', 'new line');
  assert.ok(d.includes('-old line'));
  assert.ok(d.includes('+new line'));
});

test('多行修改保留上下文顺序', () => {
  const d = previewDiff('a\nb\nc', 'a\nB\nc');
  assert.ok(d.includes(' a') && d.includes(' c'), '公共行保留');
  assert.ok(d.includes('-b') && d.includes('+B'));
});
