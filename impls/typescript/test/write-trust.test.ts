// 公共边界③：真实工具循环与审批决定，结果观察实际文件；只替换外部模型端点。
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/kernel/app.ts';
import { Registry } from '../src/kernel/registry.ts';
import { builtinPlugins } from '../src/plugins/index.ts';
import { SessionStore } from '../src/core/session.ts';
import { runUserTurn } from '../src/core/turn.ts';

function workspace() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tcode-write-trust-')));
  const trusted = path.join(root, 'trusted');
  const outside = path.join(root, 'outside');
  mkdirSync(trusted); mkdirSync(outside);
  return { root, trusted, outside };
}

async function execute(t: TestContext, root: string, trusted: string, tool: string, args: Record<string, unknown>) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(400).end('unexpected model route'); return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { messages: Array<{ role: string }> };
    const delta = body.messages.some((message) => message.role === 'tool')
      ? { content: '已检查工具结果' }
      : { tool_calls: [{ index: 0, id: 'trust-call', function: { name: tool, arguments: JSON.stringify(args) } }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const config = { apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'fixture-model', contextLimit: 100000, tcodeDir: root, allowWriteDirs: [trusted] };
  const app = createApp(config, new Registry().registerAll(builtinPlugins), {
    yolo: false, freshMessages: () => [{ role: 'system', content: '真实审批与文件结果测试' }],
    store: new SessionStore(path.join(root, 'sessions')),
  });
  const approvals: string[] = [];
  await runUserTurn(app, '按任务处理目标文件', {
    check: async (name) => { approvals.push(name); return false; }, emit: () => {},
  });
  return approvals;
}

test('白名单内符号链接指向外部目录时仍须审批，拒绝写入不能产生外部文件', async (t) => {
  const { root, trusted, outside } = workspace();
  symlinkSync(outside, path.join(trusted, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const approvals = await execute(t, root, trusted, 'write', {
    file_path: path.join(trusted, 'linked', 'out.txt'), content: '不应写入',
  });
  assert.equal(existsSync(path.join(outside, 'out.txt')), false, '拒绝后不能产生白名单外的文件');
  assert.deepEqual(approvals, ['write']);
});

test('经白名单内符号链接编辑外部文件，拒绝后原内容保留', async (t) => {
  const { root, trusted, outside } = workspace();
  writeFileSync(path.join(outside, 'existing.txt'), '原内容');
  symlinkSync(outside, path.join(trusted, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const approvals = await execute(t, root, trusted, 'edit', {
    file_path: path.join(trusted, 'linked', 'existing.txt'), old_string: '原内容', new_string: '不应修改',
  });
  assert.equal(readFileSync(path.join(outside, 'existing.txt'), 'utf8'), '原内容');
  assert.deepEqual(approvals, ['edit']);
});

test('尚未创建的普通白名单目录及嵌套新文件仍可免审批写入', async (t) => {
  const { root, trusted } = workspace();
  const allowed = path.join(trusted, 'new-allow');
  const file = path.join(allowed, 'nested', 'out.txt');
  const approvals = await execute(t, root, allowed, 'write', { file_path: file, content: '正常写入' });
  assert.equal(readFileSync(file, 'utf8'), '正常写入');
  assert.deepEqual(approvals, []);
});

test('白名单内悬空文件符号链接不能免审批创建外部目标', { skip: process.platform === 'win32' }, async (t) => {
  const { root, trusted, outside } = workspace();
  const file = path.join(outside, 'new.txt');
  symlinkSync(file, path.join(trusted, 'dangling.txt'), 'file');
  const approvals = await execute(t, root, trusted, 'write', {
    file_path: path.join(trusted, 'dangling.txt'), content: '不应创建',
  });
  assert.equal(existsSync(file), false);
  assert.deepEqual(approvals, ['write']);
});
