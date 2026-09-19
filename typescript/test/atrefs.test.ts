// @文件引用解析单测：输入中的 @path 注入文件内容，缺文件/超限如实标注。
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandAtRefs } from '../src/core/atrefs.ts';

function fakeRead(files: Record<string, string>) {
  return (p: string) => files[p] ?? null;
}

test('无 @ 引用时原样返回', () => {
  assert.equal(expandAtRefs('普通输入', fakeRead({})), '普通输入');
  assert.equal(expandAtRefs('邮箱 someone@example.com', fakeRead({})), '邮箱 someone@example.com');
});

test('@path 替换为文件内容块', () => {
  const out = expandAtRefs('看看 @src/a.ts 说明了什么', fakeRead({ 'src/a.ts': 'hello' }));
  assert.ok(out.includes('看看'), '保留原句');
  assert.ok(out.includes('[引用文件 src/a.ts]'), '有引用头');
  assert.ok(out.includes('hello'), '有文件内容');
});

test('多个 @ 引用各自注入', () => {
  const out = expandAtRefs('@a.txt 和 @b.txt', fakeRead({ 'a.txt': 'AAA', 'b.txt': 'BBB' }));
  assert.ok(out.includes('AAA') && out.includes('BBB'));
});

test('文件不存在 → 标注缺失而非报错', () => {
  const out = expandAtRefs('看看 @ghost.ts', fakeRead({}));
  assert.ok(out.includes('（文件不存在）'));
});

test('超长文件截断', () => {
  const out = expandAtRefs('看 @big.txt', fakeRead({ 'big.txt': 'x'.repeat(300_000) }));
  assert.ok(out.length < 300_000);
  assert.ok(out.includes('已截断'));
});
