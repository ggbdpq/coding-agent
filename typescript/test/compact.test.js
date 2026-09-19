// compact 单测：摘要替换历史、失败永不破坏会话、配对问题随摘要消失。
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactContext } from '../src/core/compact.ts';
import { Registry } from '../src/kernel/registry.ts';
function fakeStore() {
    const appended = [];
    return {
        appended,
        start() { },
        append(m) {
            appended.push(m);
        },
        listRecent() {
            return [];
        },
        load() {
            return [];
        },
    };
}
function fakeApp(provider, store, messages) {
    return {
        config: {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1',
            model: 'fake',
            contextLimit: 1_000_000,
            tcodeDir: '/tmp',
        },
        registry: new Registry(),
        provider,
        store,
        yolo: { value: true },
        messages,
        startSession() { },
        resetMessages() { },
    };
}
const summarizer = {
    async chat(_messages, opts) {
        opts?.onText?.('这是摘要');
        return { message: { role: 'assistant', content: '这是摘要' } };
    },
};
function historyMessages() {
    const msgs = [{ role: 'system', content: '系统提示' }];
    for (let i = 0; i < 10; i++) {
        msgs.push({ role: 'user', content: `问题 ${i}` });
        msgs.push({ role: 'assistant', content: `回答 ${i}` });
    }
    return msgs;
}
test('compact：摘要 + 保留最近 4 条原文，返回节省 token 数', async () => {
    const store = fakeStore();
    const messages = historyMessages();
    const app = fakeApp(summarizer, store, messages);
    const before = app.messages.length;
    const { savedTokens } = await compactContext(app, {});
    assert.ok(savedTokens > 0);
    assert.equal(app.messages.length, 6, 'system + 摘要 + 最近 4 条原文');
    assert.equal(app.messages[0].role, 'system');
    assert.equal(app.messages[0].content, '系统提示');
    assert.ok(app.messages[1].content.includes('这是摘要'));
    // 最近 4 条原文保留：tail 从 user 边界开始，内容与原末尾一致
    assert.equal(app.messages[2].role, 'user');
    assert.deepEqual(app.messages.slice(2), messages.slice(messages.length - 4));
    assert.ok(before > app.messages.length);
});
test('compact：配对安全切片——理想切点落在 tool 消息上时向前扫描到 user', async () => {
    // 构造 ideal 切点（len-4）恰为 tool 消息的历史：
    // 0 system,1 user,2 assistant(tc),3 tool,4 user,5 assistant(tc),6 tool,7 user,8 assistant,9 user
    const messages = [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c2', content: 'r2' },
        { role: 'user', content: 'u3' },
        { role: 'assistant', content: 'a3' },
        { role: 'user', content: 'u4' },
    ];
    const app = fakeApp(summarizer, fakeStore(), messages);
    await compactContext(app, {});
    // tail 从 idx7（user）开始，len-4=6 的 tool 不作切点
    assert.equal(app.messages.length, 5, 'system + 摘要 + 3 条尾部');
    assert.equal(app.messages[2].content, 'u3');
    // 摘要区已展平，无悬空 tool_calls
    assert.ok(!app.messages.some((m) => m.role === 'tool'));
});
test('compact：历史太短（≤4 条）时拒绝并保持原状', async () => {
    const messages = [
        { role: 'system', content: 's' },
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
    ];
    const app = fakeApp(summarizer, fakeStore(), messages);
    await assert.rejects(compactContext(app, {}), /没什么可压缩/);
    assert.equal(app.messages.length, 3);
});
test('compact：摘要失败（网络错）时原历史原封不动', async () => {
    const messages = historyMessages();
    const snapshot = JSON.parse(JSON.stringify(messages));
    const app = fakeApp({
        async chat() {
            throw new Error('网络炸了');
        },
    }, fakeStore(), messages);
    await assert.rejects(compactContext(app, {}), /网络炸了/);
    assert.deepEqual(app.messages, snapshot);
});
test('compact：用户中止时原历史原封不动', async () => {
    const messages = historyMessages();
    const app = fakeApp({
        async chat() {
            const e = new Error('x');
            e.name = 'AbortError';
            throw e;
        },
    }, fakeStore(), messages);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(compactContext(app, { signal: ac.signal }), (e) => e.name === 'AbortError');
    assert.equal(app.messages.length, 21);
});
