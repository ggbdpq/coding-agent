// calc.js 的测试：其中"负数取模"用例在当前实现下是红的，等 gcode 修复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { add, sub, mul, mod } from './calc.js';

test('加法', () => {
  assert.equal(add(2, 3), 5);
});

test('减法', () => {
  assert.equal(sub(5, 2), 3);
});

test('乘法', () => {
  assert.equal(mul(3, 4), 12);
});

test('取模：常规', () => {
  assert.equal(mod(7, 3), 1);
});

test('取模：负数也应得非负余数', () => {
  assert.equal(mod(-7, 3), 2);
});
