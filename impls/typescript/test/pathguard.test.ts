import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePath, runWithSessionCwd } from '../src/plugins/tools/pathguard.ts';

test('pathguard：..foo 目录在内，符号链接按真实目标判越界', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tcode-pathguard-')));
  const ws = path.join(root, 'ws');
  const out = path.join(root, 'out');
  mkdirSync(ws); mkdirSync(out);
  symlinkSync(out, path.join(ws, 'link'));
  runWithSessionCwd(ws, () => {
    assert.equal(resolvePath('..foo/a.txt').outside, false);
    assert.equal(resolvePath('link/x.txt').outside, true);
    assert.equal(resolvePath('new/x.txt').outside, false);
    assert.equal(resolvePath('../out/x.txt').outside, true);
  });
});
