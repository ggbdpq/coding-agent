// 技能索引扫描的错误契约（对齐 ZCode skills/scan.ts：只吞 ENOENT）。
// 目录存在但读不了（权限）时 readdirSync 必须上抛——该分支无法跨平台便携构造，
// 由源码结构保证（无吞错 try/catch）；此处锁"不存在静默跳过"。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { skillIndex } from '../src/core/systemprompt.ts';

test('目录不存在静默跳过（返回 null）', () => {
  assert.equal(skillIndex([path.join('Z:', 'surely-not-exist', 'skills')]), null);
});
