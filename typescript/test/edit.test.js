// edit 工具单测：唯一性判定是误伤防线，锁死行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit } from '../src/plugins/tools/edit.ts';
test('唯一匹配时替换成功', () => {
    const r = applyEdit('const a = 1;\nconst b = 2;', 'const b = 2;', 'const b = 3;', false);
    assert.equal(r.ok, true);
    assert.equal(r.message, 'one');
});
test('未找到时报错并提示核对原文', () => {
    const r = applyEdit('hello', 'world', 'x', false);
    assert.equal(r.ok, false);
    assert.match(r.message, /未找到/);
});
test('多处出现且未开 replace_all 时拒绝', () => {
    const r = applyEdit('x = 1; x = 2;', 'x = ', 'y = ', false);
    assert.equal(r.ok, false);
    assert.match(r.message, /2 次/);
});
test('replace_all 档位放行', () => {
    const r = applyEdit('a\nb\na', 'a', 'c', true);
    assert.equal(r.ok, true);
    assert.equal(r.message, 'all');
});
test('空 old_string 拒绝', () => {
    const r = applyEdit('abc', '', 'x', false);
    assert.equal(r.ok, false);
});
