// 已确认的 HTTP/模型边界：上下文快照恢复，模型为外部端点，文件和 CLI 进程都真实。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`等待超时：${label}`);
}

async function harness(t, summaryMode = 'success', toolMode = 'unique') {
  const dir = mkdtempSync(path.join(tmpdir(), 'tcode-context-'));
  const workspace = path.join(dir, 'project'); mkdirSync(workspace);
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); requests.push(request);
    if (toolMode === 'reused') {
      // 外部端点按每批调用验证配对；不同批次允许复用同一个 call id。
      let pending = new Set(), invalid = false;
      for (const message of request.messages) {
        if (message.role === 'tool') { if (!pending.delete(message.tool_call_id)) invalid = true; }
        else {
          if (pending.size) invalid = true;
          pending = new Set((message.tool_calls ?? []).map((call) => call.id));
        }
      }
      if (invalid || pending.size) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '工具调用缺少当前批次结果' } })); return;
      }
    }
    const summary = !request.tools;
    const user = request.messages.findLast((message) => message.role === 'user').content;
    const content = summary ? '摘要：仅保留关键背景' : `reply ${user}`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const current = request.messages.slice(request.messages.findLastIndex((message) => message.role === 'user') + 1);
    const readFirst = toolMode === 'reused' && ['repeat history', 'repeat cancel'].includes(user) && !current.length;
    const writeNext = toolMode === 'reused' && user === 'repeat cancel' && current.at(-1)?.role === 'tool'
      && !current.some((message) => message.tool_calls?.some((call) => call.function.name === 'write'));
    if (!summary && (readFirst || writeNext)) {
      const name = readFirst ? 'read' : 'write';
      const args = readFirst ? { file_path: 'tool-output.txt' } : { file_path: 'cancelled.txt', content: 'must not write' };
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'reused', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`);
    } else if (!summary && /^tool \d+$/.test(user) && request.messages.at(-1).role !== 'tool') {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-' + user, function: { name: 'read', arguments: '{"file_path":"tool-output.txt"}' } }] } }] })}\n\n`);
    } else if (!summary || summaryMode !== 'empty') res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: summary ? 23 : 5, completion_tokens: summary ? 5 : 2 }, choices: [] })}\n\n`);
    if (!summary || summaryMode !== 'slow') res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, TCODE_DATA_DIR: path.join(dir, 'data'), TCODE_API_KEY: 'fixture-key',
    TCODE_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, TCODE_MODEL: 'fixture-model',
    TCODE_PROTOCOL: 'openai', TCODE_CONTEXT_LIMIT: '', TCODE_APPROVAL: 'normal', TCODE_ALLOW_WRITE: '' };
  let child, url;
  async function close() {
    if (child && child.exitCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve)); child.kill(); await closed;
    }
  }
  async function start() {
    let stdout = '', stderr = '';
    child = spawn(process.execPath, [path.join(root, 'bin/tcode.js'), 'web'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
    url = await until(() => {
      if (child.exitCode !== null) throw new Error(`后端退出：${stderr}`);
      return stdout.match(/http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]+\//)?.[0];
    }, '后端地址');
  }
  t.after(async () => { await close(); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); });
  await start();
  const state = async () => (await fetch(url + 'state')).json();
  const post = async (route, body) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const run = async (text) => { assert.equal((await post('send', { text })).status, 200); await until(async () => !(await state()).busy, '本轮完成'); };
  return { dir, workspace, requests, env, state, post, run, usage: async () => (await fetch(url + 'usage')).json(),
    exec: async (text) => {
      const cli = spawn(process.execPath, [path.join(root, 'bin/tcode.js'), 'exec', text, '--continue', '--yolo'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; cli.stdout.on('data', (chunk) => output += chunk); cli.stderr.on('data', (chunk) => output += chunk);
      assert.equal(await new Promise((resolve) => cli.once('close', resolve)), 0, output);
    },
    resume: async (text) => {
      const cli = spawn(process.execPath, [path.join(root, 'bin/tcode.js'), '--yolo'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
      t.after(() => cli.kill());
      let output = ''; cli.stdout.on('data', (chunk) => output += chunk); cli.stderr.on('data', (chunk) => output += chunk);
      const prompts = () => (output.match(/tcode❯/g) ?? []).length;
      await until(() => prompts() === 1, 'CLI 首个输入提示'); cli.stdin.write('/resume 1\n');
      await until(() => prompts() === 2, 'CLI 恢复完成'); cli.stdin.write(text + '\n');
      await until(() => prompts() === 3, 'CLI 本轮完成');
      const closed = new Promise((resolve) => cli.once('close', resolve)); cli.kill(); await closed;
      assert.match(output, /已恢复/);
    },
    crash: async () => { const closed = new Promise((resolve) => child.once('close', resolve)); child.kill('SIGKILL'); await closed; child = undefined; },
    restart: async (beforeStart) => { await close(); await beforeStart?.(); await start(); } };
}

async function seed(h) { for (const text of ['history 1', 'history 2', 'history 3']) await h.run(text); }

test('手动压缩切回会话后模型仍收到摘要，完整界面历史与用量保留且旧文件不变', async (t) => {
  const h = await harness(t); await seed(h);
  const before = await h.state();
  assert.equal((await h.post('command', { line: '/compact' })).status, 200);
  const compressed = await h.state();
  const original = path.join(h.dir, 'data', 'sessions', before.currentSessionId);
  const bytes = readFileSync(original);
  const usage = await h.usage();
  await h.post('session/new', {}); await h.post('session/select', { id: before.currentSessionId });
  const restored = await h.state();
  assert.deepEqual(restored.messages, compressed.messages);
  assert.equal(restored.title, before.title);
  assert.ok(restored.activity.some((event) => event.type === 'user' && event.text === 'history 1'));
  assert.deepEqual(await h.usage(), usage);
  await h.run('after switch');
  const sent = h.requests.at(-1).messages;
  assert.ok(sent.some((message) => message.content?.includes('摘要：仅保留关键背景')));
  assert.equal(sent.some((message) => message.content === 'history 1'), false);
  assert.deepEqual(readFileSync(original), bytes);
});

test('连续两次 CLI --continue 都保留压缩背景及恢复后追加的消息', async (t) => {
  const h = await harness(t); await seed(h);
  await h.post('command', { line: '/compact' });
  await h.exec('cli first');
  assert.ok(h.requests.at(-1).messages.some((message) => message.content?.includes('摘要：仅保留关键背景')));
  await h.exec('cli second');
  const sent = h.requests.at(-1).messages;
  assert.ok(sent.some((message) => message.content?.includes('摘要：仅保留关键背景')));
  assert.ok(sent.some((message) => message.content === 'cli first'));
  assert.equal(sent.some((message) => message.content === 'history 1'), false);
});

test('连续两次 CLI /resume 都保留摘要和恢复后的输入', async (t) => {
  const h = await harness(t); await seed(h);
  await h.post('command', { line: '/compact' });
  await h.resume('resume first');
  assert.ok(h.requests.at(-1).messages.some((message) => message.content?.includes('摘要：仅保留关键背景')));
  await h.resume('resume second');
  const sent = h.requests.at(-1).messages;
  assert.ok(sent.some((message) => message.content?.includes('摘要：仅保留关键背景')));
  assert.ok(sent.some((message) => message.content === 'resume first'));
});

test('自动压缩后消息已落盘但终态缺失，重启恢复不能重复最后一轮', async (t) => {
  const h = await harness(t); await seed(h); await h.run('history 4');
  await h.post('config', { contextLimit: 1 }); await h.run('same input');
  const finished = await h.state();
  await h.post('config', { contextLimit: 100000 });
  const original = path.join(h.dir, 'data', 'sessions', finished.currentSessionId);
  await h.restart(() => {
    const records = readFileSync(original, 'utf8').trimEnd().split('\n');
    assert.equal(JSON.parse(records.at(-1)).event.type, 'turn_end');
    // 公共启动输入：保留真实 JSONL 在消息已写完、终态尚未写入时的合法前缀。
    writeFileSync(original, records.slice(0, -1).join('\n') + '\n');
  });
  const restored = await h.state();
  assert.equal(restored.status, 'aborted');
  assert.deepEqual(restored.messages, finished.messages);
  await h.run('same input');
  const sent = h.requests.at(-1).messages;
  assert.equal(sent.filter((message) => message.role === 'user' && message.content === 'same input').length, 2, '真正重复的输入两轮均须保留');
});

test('压缩后本轮消息只落盘用户输入，重启仍完整重放工具结果和回答', async (t) => {
  const h = await harness(t); await seed(h); await h.run('history 4');
  writeFileSync(path.join(h.workspace, 'tool-output.txt'), 'preserved tool result');
  await h.post('config', { contextLimit: 1 }); await h.run('tool 14');
  const completed = await h.state(); await h.post('config', { contextLimit: 100000 });
  const original = path.join(h.dir, 'data', 'sessions', completed.currentSessionId);
  await h.restart(() => {
    const lines = readFileSync(original, 'utf8').trimEnd().split('\n');
    const user = lines.findLastIndex((line) => {
      const record = JSON.parse(line);
      return record.type === 'message' && record.message.role === 'user';
    });
    // WP6 增量落盘：user 消息行先于本轮后续 activity 事件写盘，真实崩溃不会丢事件流。
    // 模拟"只落盘用户输入、终态缺失"：丢 user 之后的 message 行（内容由事件流回放）、
    // 丢末尾 turn_end 保持轮未完成，保留 activity 事件。
    const kept = lines.slice(0, user + 1).concat(
      lines.slice(user + 1)
        .filter((line) => { const record = JSON.parse(line); return record.type !== 'message' && record.event?.type !== 'turn_end'; }),
    );
    writeFileSync(original, kept.join('\n') + '\n');
  });
  const restored = await h.state();
  assert.deepEqual(restored.messages.map((message) => ({ ...message, content: message.content ?? '' })),
    completed.messages.map((message) => ({ ...message, content: message.content ?? '' })));
  assert.equal(restored.messages.filter((message) => message.role === 'user' && message.content === 'tool 14').length, 1);
  assert.ok(restored.messages.some((message) => message.role === 'tool' && message.content.includes('preserved tool result')));
});

test('自动压缩后连续重启保留摘要与后续消息，完整界面历史和用量不重复', async (t) => {
  const h = await harness(t); await seed(h); await h.run('history 4');
  await h.post('config', { contextLimit: 1 }); await h.run('after auto compact');
  await h.post('config', { contextLimit: 100000 });
  const completed = await h.state(), usage = await h.usage();
  for (let i = 0; i < 2; i++) {
    await h.restart();
    const restored = await h.state();
    assert.deepEqual(restored.messages, completed.messages);
    assert.equal(restored.title, completed.title);
    assert.ok(restored.activity.some((event) => event.type === 'user' && event.text === 'history 1'));
    assert.deepEqual(await h.usage(), usage);
  }
  await h.run('later');
  const sent = h.requests.at(-1).messages;
  assert.equal(sent.filter((message) => message.content?.includes('摘要：仅保留关键背景')).length, 1);
  assert.ok(sent.some((message) => message.content === 'after auto compact'));
  assert.equal(sent.some((message) => message.content === 'history 1'), false);
});

test('摘要失败或停止后重启仍恢复完整原历史', async (t) => {
  for (const mode of ['empty', 'slow', 'auto-stop']) {
    await t.test(mode, async (s) => {
      const h = await harness(s, mode === 'empty' ? 'empty' : 'slow'); await seed(h);
      const before = (await h.state()).messages;
      let command;
      if (mode === 'auto-stop') {
        await h.post('config', { contextLimit: 1 }); await h.post('send', { text: 'cancelled' });
      } else command = h.post('command', { line: '/compact' });
      if (mode !== 'empty') {
        await until(async () => (await h.state()).usage.prompt_tokens === 38, '摘要 usage');
        await h.post('abort', {});
      }
      if (command) assert.match((await command).body.output, /压缩未执行/);
      else await until(async () => !(await h.state()).busy, '自动压缩停止');
      await h.restart();
      assert.deepEqual((await h.state()).messages, before);
      assert.equal((await h.state()).usage.prompt_tokens, 38);
    });
  }
});

test('压缩快照落盘失败时原上下文和旧文件保留，不报告已压缩', async (t) => {
  const h = await harness(t); await seed(h);
  const before = await h.state();
  const file = path.join(h.dir, 'data', 'sessions', before.currentSessionId);
  const bytes = readFileSync(file); chmodSync(file, 0o400);
  try {
    const failed = await h.post('command', { line: '/compact' });
    assert.match(failed.body.output, /压缩未执行/);
    assert.deepEqual(failed.body.state.messages, before.messages);
    assert.deepEqual(readFileSync(file), bytes);
  } finally { chmodSync(file, 0o600); }
  await h.restart();
  assert.deepEqual((await h.state()).messages, before.messages);
});

test('摘要失败后的工具输出裁剪可跨重启恢复，界面仍保留完整工具结果', async (t) => {
  const h = await harness(t, 'empty');
  writeFileSync(path.join(h.workspace, 'tool-output.txt'), 'bulk history '.repeat(400));
  for (let i = 0; i < 14; i++) await h.run(`tool ${i}`);
  await h.post('config', { contextLimit: 1000 }); await h.run('after trim');
  const trimmed = await h.state();
  assert.equal(trimmed.messages.filter((message) => message.role === 'tool' && message.content === '[早期工具输出已省略以释放上下文]').length, 2);
  assert.ok(trimmed.activity.some((event) => event.type === 'tool_result' && event.output.includes('bulk history')));
  await h.post('config', { contextLimit: 100000 }); await h.restart();
  const restored = await h.state();
  assert.equal(restored.messages.filter((message) => message.role === 'tool' && message.content === '[早期工具输出已省略以释放上下文]').length, 2);
  assert.deepEqual(restored.messages, trimmed.messages);
  await h.run('after restart');
  assert.equal(h.requests.at(-1).messages.filter((message) => message.role === 'tool' && message.content === '[早期工具输出已省略以释放上下文]').length, 2);
});

test('工具裁剪的快照落盘失败时保留原输出且不追加本轮输入', async (t) => {
  const h = await harness(t, 'empty');
  writeFileSync(path.join(h.workspace, 'tool-output.txt'), 'bulk history '.repeat(400));
  for (let i = 0; i < 14; i++) await h.run(`tool ${i}`);
  const before = await h.state();
  const file = path.join(h.dir, 'data', 'sessions', before.currentSessionId);
  const bytes = readFileSync(file);
  await h.post('config', { contextLimit: 1000 }); chmodSync(file, 0o400);
  try {
    await h.run('must not append');
    const failed = await h.state();
    assert.equal(failed.status, 'error');
    assert.deepEqual(failed.messages, before.messages);
    assert.deepEqual(readFileSync(file), bytes);
  } finally { chmodSync(file, 0o600); }
});

test('旧 JSONL 已有未配对工具调用时，取消自动摘要不替旧回合补写结果', async (t) => {
  const h = await harness(t, 'slow');
  await h.restart(() => {
    const records = [{ type: 'meta', ts: Date.now(), cwd: realpathSync(h.workspace), sessionId: 'legacy.jsonl' }];
    for (let i = 0; i < 4; i++) {
      records.push({ type: 'message', message: { role: 'user', content: `legacy ${i}` } },
        { type: 'message', message: { role: 'assistant', content: `legacy reply ${i}` } });
    }
    records.push({ type: 'message', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'old-unpaired', type: 'function', function: { name: 'read', arguments: '{"file_path":"old.txt"}' } }] } });
    writeFileSync(path.join(h.dir, 'data', 'sessions', 'legacy.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  });
  const before = (await h.state()).messages;
  await h.post('config', { contextLimit: 1 }); await h.post('send', { text: 'cancelled before input' });
  await until(async () => (await h.state()).usage.prompt_tokens === 23, '摘要 usage');
  await h.post('abort', {}); await until(async () => !(await h.state()).busy, '本轮停止');
  assert.deepEqual((await h.state()).messages, before);
});

test('同一轮复用旧工具 ID 时，停止审批仍补齐最后一批调用，重启后可继续', async (t) => {
  const h = await harness(t, 'success', 'reused');
  writeFileSync(path.join(h.workspace, 'tool-output.txt'), 'existing read result');
  await h.run('repeat history');
  await h.post('send', { text: 'repeat cancel' });
  await until(async () => (await h.state()).pending.some((permission) => permission.tool === 'write'), '写入审批');
  await h.post('abort', {}); await until(async () => !(await h.state()).busy, '任务已停止');
  const stopped = await h.state();
  assert.equal(stopped.status, 'aborted');
  assert.equal(stopped.messages.at(-1).role, 'tool');
  assert.equal(stopped.messages.at(-1).tool_call_id, 'reused');
  assert.match(stopped.messages.at(-1).content, /本轮中断/);
  await h.restart(); await h.run('continue after cancel');
  assert.equal((await h.state()).status, 'completed', '外部端点接受每批均已配对的上下文');
});

test('恢复日志再遇终态缺失，连续重启不会重复原输入', async (t) => {
  const h = await harness(t); await h.run('recover original');
  const before = await h.state(), id = before.currentSessionId;
  const directory = path.join(h.dir, 'data', 'sessions');
  await h.restart(() => {
    const file = path.join(directory, id), lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    writeFileSync(file, lines.slice(0, -1).join('\n') + '\n');
  });
  assert.deepEqual((await h.state()).messages, before.messages);
  await h.restart(() => {
    const latest = readdirSync(directory).filter((name) => name.endsWith('.jsonl'))
      .map((name) => ({ name, mtime: statSync(path.join(directory, name)).mtimeMs,
        meta: JSON.parse(readFileSync(path.join(directory, name), 'utf8').split('\n')[0]) }))
      .filter((file) => file.meta.sessionId === id).sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))[0];
    const file = path.join(directory, latest.name), lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    assert.equal(JSON.parse(lines.at(-1)).event.reason, 'aborted');
    writeFileSync(file, lines.slice(0, -1).join('\n') + '\n');
  });
  assert.deepEqual((await h.state()).messages, before.messages);
  await h.run('continue after recovery');
  assert.equal(h.requests.at(-1).messages.filter((message) => message.content === 'recover original').length, 1);
});

test('恢复新文件发布失败保留当前会话，半文件不进入历史列表', async (t) => {
  const h = await harness(t); await seed(h);
  const saved = await h.state(), directory = path.join(h.dir, 'data', 'sessions');
  const oldFile = path.join(directory, saved.currentSessionId), bytes = readFileSync(oldFile);
  await h.post('session/new', {});
  const active = await h.state(), files = readdirSync(directory).sort();
  chmodSync(directory, 0o500);
  try {
    const failed = await h.post('session/select', { id: saved.currentSessionId });
    assert.equal(failed.status, 500);
    const state = await h.state();
    assert.equal(state.currentSessionId, active.currentSessionId);
    assert.deepEqual(state.messages, active.messages);
    assert.deepEqual(readdirSync(directory).sort(), files);
    assert.deepEqual(readFileSync(oldFile), bytes);
  } finally { chmodSync(directory, 0o700); }
  await h.run('after failed restore');
  assert.equal((await h.state()).currentSessionId, active.currentSessionId);
  assert.equal(h.requests.at(-1).messages.some((message) => message.content === 'history 1'), false);
});

test('恢复标记只匹配原回合，新回合未落盘时不会删除相同的旧输入', async (t) => {
  const h = await harness(t); await h.run('same pending input'); await h.restart();
  const id = (await h.state()).currentSessionId, directory = path.join(h.dir, 'data', 'sessions');
  await h.restart(() => {
    const latest = readdirSync(directory).filter((name) => name.endsWith('.jsonl'))
      .map((name) => ({ name, mtime: statSync(path.join(directory, name)).mtimeMs,
        meta: JSON.parse(readFileSync(path.join(directory, name), 'utf8').split('\n')[0]) }))
      .filter((file) => file.meta.sessionId === id).sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))[0];
    const file = path.join(directory, latest.name), records = readFileSync(file, 'utf8').trimEnd();
    writeFileSync(file, records + '\n' + [
      { type: 'activity', event: { type: 'turn_start', id: 'new-incomplete-turn', seq: 100 } },
      { type: 'activity', event: { type: 'user', text: 'same pending input', seq: 101 } },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  });
  const restored = await h.state();
  assert.equal(restored.messages.filter((message) => message.role === 'user' && message.content === 'same pending input').length, 2);
  assert.ok(restored.messages.some((message) => message.content === 'reply same pending input'));
});

test('审批时真实 SIGKILL 后恢复当前批复用的工具 ID，模型仍接受已配对上下文', async (t) => {
  const h = await harness(t, 'success', 'reused');
  writeFileSync(path.join(h.workspace, 'tool-output.txt'), 'existing read result');
  await h.run('repeat history'); await h.post('send', { text: 'repeat cancel' });
  await until(async () => (await h.state()).pending.some((permission) => permission.tool === 'write'), '写入审批');
  const id = (await h.state()).currentSessionId, file = path.join(h.dir, 'data', 'sessions', id);
  await h.crash(); const bytes = readFileSync(file);
  await h.restart(); await h.run('continue after real crash');
  assert.equal((await h.state()).status, 'completed', '复用 ID 的旧批结果不能抵消当前批缺失结果');
  assert.deepEqual(readFileSync(file), bytes);
});
