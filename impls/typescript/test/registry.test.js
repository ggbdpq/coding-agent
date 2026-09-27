// 内核注册表单测：锁死按类取用、重名拒绝、schema 形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../src/kernel/registry.ts';
import { definePlugin } from '../src/kernel/plugin.ts';
const fakeTool = definePlugin({
    name: 't1',
    kind: 'tool',
    description: '测试工具',
    parameters: { type: 'object', properties: {} },
    needsPermission: false,
    preview: () => '',
    run: async () => 'ok',
});
const fakeProvider = definePlugin({
    name: 'fake',
    kind: 'provider',
    matches: () => true,
    create: () => ({ chat: async () => ({ message: { role: 'assistant', content: '' } }) }),
});
const fakeCommand = definePlugin({
    name: 'cmd1',
    kind: 'command',
    usage: '/cmd1',
    summary: '测试命令',
    run: async () => { },
});
const fakeShell = definePlugin({ name: 'repl', kind: 'shell', start: async () => { } });
test('注册后按类取用', () => {
    const r = new Registry().registerAll([fakeTool, fakeProvider, fakeCommand, fakeShell]);
    assert.equal(r.tools().length, 1);
    assert.equal(r.providers().length, 1);
    assert.equal(r.commands().length, 1);
    assert.equal(r.shell('repl')?.name, 'repl');
    assert.equal(r.shell('不存在'), undefined);
});
test('同 kind 重名拒绝，跨 kind 同名允许', () => {
    const r = new Registry().register(fakeTool);
    assert.throws(() => r.register({ ...fakeTool, name: 't1' }), /插件重名/);
    r.register({ ...fakeCommand, name: 't1' }); // 不同 kind，允许
});
test('toolSchemas 输出 function calling 形状', () => {
    const r = new Registry().register(fakeTool);
    const schemas = r.toolSchemas();
    assert.deepEqual(schemas, [
        {
            type: 'function',
            function: { name: 't1', description: '测试工具', parameters: { type: 'object', properties: {} } },
        },
    ]);
});
