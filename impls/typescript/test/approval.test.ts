// 审批策略与写白名单单测：config.allowWriteDirs 内的写操作免确认，外必问。
// WP4：第四态 scoped（"本会话允许此类"）按授权键记忆，always/yolo 原语义不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import writeTool from '../src/plugins/tools/write.ts';
import editTool from '../src/plugins/tools/edit.ts';
import bashTool from '../src/plugins/tools/bash.ts';
import {
  createPermissionGate,
  type PermissionDecision,
  type PermissionRequest,
} from '../src/core/permission.ts';
import type { ToolPlugin } from '../src/kernel/plugin.ts';
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

// ---- WP4：scoped 第四态（调用方兜底规则与 agentloop 一致：工具声明 grantKey 就用它的返回值，可为空；否则用工具名）----

function callerKey(tool: ToolPlugin, args: Record<string, unknown>): string | undefined {
  return tool.grantKey ? tool.grantKey(args) : tool.name;
}

function recordingGate(answers: PermissionDecision[], asks: PermissionRequest[], grants = new Set<string>()) {
  let round = 0;
  const yolo = { value: false };
  const gate = createPermissionGate(
    { ask: async (req) => { asks.push(req); return answers[round++]; } },
    yolo,
    grants
  );
  return { gate, yolo };
}

test('WP4 scoped 只记住授权键：write 选 scoped 后，bash 仍逐次询问', async () => {
  const asks: PermissionRequest[] = [];
  const { gate, yolo } = recordingGate(['scoped', 'allow'], asks);
  assert.equal(await gate('write', '写入 a.txt', callerKey(writeTool, { file_path: 'a.txt', content: 'x' })), true);
  assert.equal(asks[0].grantKey, 'write');
  assert.equal(asks[0].grantLabel, '本会话允许所有 write');
  assert.equal(yolo.value, false); // scoped 不等于 always，不全局放行
  // bash 是另一类授权键 → 仍询问
  assert.equal(await gate('bash', '执行命令', callerKey(bashTool, { command: 'echo hi' })), true);
  assert.equal(asks.length, 2);
  assert.equal(asks[1].grantKey, 'bash:echo');
});

test('WP4 scoped 按首词记忆：bash:npm scoped 后 npm run build 免问、rm 仍问', async () => {
  const asks: PermissionRequest[] = [];
  const { gate } = recordingGate(['scoped', 'allow'], asks);
  assert.equal(await gate('bash', '$ npm test', callerKey(bashTool, { command: 'npm test' })), true);
  assert.equal(asks[0].grantKey, 'bash:npm');
  assert.equal(asks[0].grantLabel, '本会话允许 npm 命令');
  // 同首词的另一条命令不再询问
  assert.equal(await gate('bash', '$ npm run build', callerKey(bashTool, { command: 'npm run build' })), true);
  assert.equal(asks.length, 1);
  // 不同首词仍询问
  assert.equal(await gate('bash', '$ rm -rf x', callerKey(bashTool, { command: 'rm -rf x' })), true);
  assert.equal(asks.length, 2);
  assert.equal(asks[1].grantKey, 'bash:rm');
});

test('WP4 复合 bash 命令不可 scoped：grantKey 为空，权限请求不提供 scoped', async () => {
  assert.equal(typeof bashTool.grantKey, 'function'); // bash 必须声明 grantKey 才谈得上不可 scoped
  for (const command of ["bash -c 'rm x'", 'npm test && rm x', 'cat a | sh']) {
    assert.equal(bashTool.grantKey!({ command }), undefined, command);
  }
  // 请求级：grantKey 为空 → PermissionRequest 不带 grantKey/grantLabel（壳不显示 scoped 选项）
  const asks: PermissionRequest[] = [];
  const { gate } = recordingGate(['allow'], asks);
  assert.equal(await gate('bash', '$ npm test && rm x', bashTool.grantKey!({ command: 'npm test && rm x' })), true);
  assert.equal(asks[0].grantKey, undefined);
  assert.equal(asks[0].grantLabel, undefined);
});

test('WP4 always 仍全局放行（R3 原语义）：置 yolo 后任意工具不再询问', async () => {
  const asks: PermissionRequest[] = [];
  const { gate, yolo } = recordingGate(['always'], asks);
  assert.equal(await gate('bash', '$ npm test', 'bash:npm'), true);
  assert.equal(yolo.value, true);
  assert.equal(await gate('write', '写入', 'write'), true); // 不再询问
  assert.equal(asks.length, 1);
});
