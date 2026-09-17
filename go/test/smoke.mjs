// 端到端冒烟（无网络）：本地假 SSE 服务器按剧本回包。
// 场景A：OpenAI 协议工具闭环——流式正文 → 工具调用 → bash 执行 → 结果回流 → 最终回答。
// 场景B：退出后重开进程，/resume 列表 → 加载 → 恢复的历史随新请求发给模型。
// 场景C：Anthropic 协议（BASE_URL 含 /anthropic 自动识别）完整工具轮。
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bodies = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    bodies.push(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // ---------- Anthropic 协议分支（/v1/messages） ----------
    if (req.url?.endsWith('/v1/messages')) {
      if (raw.includes('tool_result')) {
        // 工具结果已回流：给最终回答
        send({ type: 'message_start', message: { role: 'assistant' } });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '验证完成：smoke-anthropic' } });
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
        send({ type: 'message_stop' });
      } else {
        // 第一轮：正文 + 分两片的 tool_use input（考验碎片拼装）
        send({ type: 'message_start', message: { role: 'assistant' } });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我先跑个命令确认环境。' } });
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_smoke', name: 'bash' } });
        send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } });
        send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"echo smoke-anthropic"}' } });
        send({ type: 'content_block_stop', index: 1 });
        send({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
        send({ type: 'message_stop' });
      }
      res.end();
      return;
    }

    // ---------- OpenAI 协议分支（/v1/chat/completions） ----------
    // 按"最后一条消息的角色"分场：tool=工具结果已回流；user=按输入文本路由场景
    let lastRole = null;
    let lastText = '';
    try {
      const parsed = JSON.parse(raw);
      const msgs = parsed?.messages ?? [];
      if (msgs.length > 0) {
        lastRole = msgs[msgs.length - 1].role;
        lastText = String(msgs[msgs.length - 1].content ?? '');
      }
    } catch {
      /* 保底走默认分支 */
    }
    const text = (content, finish) => {
      send({ choices: [{ delta: { content } }] });
      send({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 3 } });
      res.write('data: [DONE]\n\n');
      res.end();
    };

    if (lastRole === 'tool') {
      // 工具结果已回流（含被拦截的 web_fetch）：给最终回答
      text('验证完成：smoke-ok', 'stop');
    } else if (lastText.includes('继续')) {
      // 场景B：恢复历史后的追问
      text('好的，继续。', 'stop');
    } else if (lastText.includes('试试抓取')) {
      // 场景D：诱导抓取内网地址，验证 SSRF 拦截
      send({ choices: [{ delta: { role: 'assistant', content: '我来抓取这个地址试试。' } }] });
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_fetch',
                  type: 'function',
                  function: { name: 'web_fetch', arguments: '{"url":"http://127.0.0.1:9/private"}' },
                },
              ],
            },
          },
        ],
      });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // 场景A第一轮：流式正文 + 一个 bash 工具调用
      send({ choices: [{ delta: { role: 'assistant', content: '我先跑个命令确认环境。' } }] });
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_smoke',
                  type: 'function',
                  function: { name: 'bash', arguments: '{"command":"echo smoke-ok"}' },
                },
              ],
            },
          },
        ],
      });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const home = mkdtempSync(path.join(tmpdir(), 'gcode-smoke-'));
const env = {
  ...process.env,
  GCODE_API_KEY: 'test-key',
  GCODE_BASE_URL: `http://127.0.0.1:${port}/v1`,
  GCODE_MODEL: 'fake-model',
  HOME: home,
  USERPROFILE: home,
};

function startGcode(extraArgs = [], envExtra = {}) {
  const child = spawn(process.execPath, [path.join(repoDir, 'bin', 'gcode.js'), ...extraArgs], {
    cwd: home,
    env: { ...env, ...envExtra },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return {
    child,
    out: () => out,
  };
}

/** 依次执行 steps：每步先等 wait 文本出现（可选）再写入 */
async function runGcode(g, steps, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (const step of steps) {
    while (step.wait && !g.out().includes(step.wait) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    g.child.stdin.write(step.write);
  }
  // 给最后一条命令的处理留点收尾时间
  await new Promise((r) => setTimeout(r, 500));
  g.child.stdin.write('/exit\n');
  await new Promise((r) => {
    g.child.on('close', (code) => r(code));
    setTimeout(() => {
      g.child.kill();
      r(0);
    }, 3000);
  });
}

// ---------- 场景A：工具闭环 ----------
{
  const g = startGcode(['--yolo']);
  await runGcode(g, [
    { write: '跑一下冒烟测试\n' },
    { write: '', wait: '验证完成：smoke-ok' },
  ]);
  const out = g.out();
  assert.ok(out.includes('我先跑个命令'), 'A: 未见流式正文\n' + out);
  assert.ok(out.includes('验证完成：smoke-ok'), 'A: 未见最终回答\n' + out);
  assert.ok(out.includes('smoke-ok'), 'A: 未见 bash 工具输出回显\n' + out);
  assert.ok(
    bodies.some((b) => b.includes('"role":"tool"') && b.includes('smoke-ok')),
    'A: 第二轮请求未携带工具结果'
  );
  console.log('冒烟A通过：流式正文 → 工具调用 → bash 执行 → 结果回流 → 最终回答');
}

// ---------- 场景B：会话 /resume ----------
{
  const bodiesBefore = bodies.length;
  const g = startGcode();
  await runGcode(g, [
    { write: '/resume\n' },
    { write: '/resume 1\n', wait: '最近的会话' },
    { write: '继续\n', wait: '已恢复' },
    { write: '', wait: '好的，继续。' },
  ]);
  const out = g.out();
  assert.ok(out.includes('最近的会话'), 'B: /resume 未列出历史会话\n' + out);
  assert.ok(out.includes('跑一下冒烟测试'), 'B: 列表未显示上一会话标签\n' + out);
  assert.ok(out.includes('已恢复'), 'B: 未见恢复确认\n' + out);
  assert.ok(out.includes('好的，继续。'), 'B: 未见恢复后的回答\n' + out);
  const newBodies = bodies.slice(bodiesBefore);
  assert.ok(
    newBodies.some((b) => b.includes('跑一下冒烟测试') && b.includes('继续')),
    'B: 恢复的历史未随新请求发给模型'
  );
  console.log('冒烟B通过：/resume 跨进程恢复会话，历史随请求发送');
}

// ---------- 场景C：Anthropic 协议工具闭环（自动识别 /anthropic） ----------
{
  const home2 = mkdtempSync(path.join(tmpdir(), 'gcode-smoke-anthropic-'));
  const g = startGcode(['--yolo'], {
    GCODE_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
    HOME: home2,
    USERPROFILE: home2,
  });
  await runGcode(g, [{ write: '跑一下 Anthropic 冒烟\n' }, { write: '', wait: '验证完成：smoke-anthropic' }]);
  const out = g.out();
  assert.ok(out.includes('我先跑个命令'), 'C: 未见流式正文\n' + out);
  assert.ok(out.includes('验证完成：smoke-anthropic'), 'C: 未见最终回答\n' + out);
  assert.ok(out.includes('smoke-anthropic'), 'C: 未见 bash 工具输出回显\n' + out);
  const anthroBodies = bodies.filter((b) => b.includes('smoke-anthropic'));
  assert.ok(
    anthroBodies.some((b) => b.includes('"tool_result"') && b.includes('smoke-anthropic')),
    'C: 第二轮请求未携带 tool_result'
  );
  assert.ok(
    anthroBodies.some((b) => b.includes('"input_schema"') && b.includes('"max_tokens"') && b.includes('"system"')),
    'C: 请求缺 Anthropic 必备字段（input_schema/max_tokens/system）'
  );
  console.log('冒烟C通过：Anthropic 协议自动识别，工具闭环跑通');
}

// ---------- 场景D：web_fetch 的 SSRF 拦截面 ----------
{
  const home3 = mkdtempSync(path.join(tmpdir(), 'gcode-smoke-fetch-'));
  const g = startGcode(['--yolo'], { HOME: home3, USERPROFILE: home3 });
  await runGcode(g, [
    { write: '试试抓取 http://127.0.0.1:9/private\n' },
    { write: '', wait: 'SSRF 防护' },
    { write: '', wait: '验证完成：smoke-ok' },
  ]);
  const out = g.out();
  assert.ok(out.includes('已拦截'), 'D: SSRF 拦截未生效\n' + out);
  assert.ok(out.includes('验证完成：smoke-ok'), 'D: 拦截后会话未正常收尾\n' + out);
  assert.ok(
    bodies.some((b) => b.includes('"role":"tool"') && b.includes('SSRF 防护')),
    'D: 拦截结果未回流给模型'
  );
  console.log('冒烟D通过：web_fetch 拦截内网地址，结果回流，会话正常继续');
}

// ---------- 场景E：web 壳（HTTP + SSE + 安全闸 + 权限双模式） ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const extractUrl = (out) => out.match(/http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]+\//)?.[0] ?? null;

async function waitUrl(g, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const u = extractUrl(g.out());
    if (u) return u;
    await sleep(100);
  }
  throw new Error('E: 未见服务地址\n' + g.out());
}

function sseCollect(url) {
  const events = [];
  const req = http.get(url + 'events', (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data:'));
        if (line) events.push(JSON.parse(line.slice(5).trim()));
      }
    });
  });
  // stop() 销毁连接后的异步 ECONNRESET 不构成失败
  req.on('error', () => {});
  return { events, stop: () => req.destroy() };
}

async function waitForEvent(events, pred, label, timeoutMs = 20_000, from = 0) {
  const deadline = Date.now() + timeoutMs;
  let i = from;
  while (Date.now() < deadline) {
    for (; i < events.length; i++) {
      if (pred(events[i])) return { ev: events[i], index: i };
    }
    await sleep(60);
  }
  throw new Error(`E: 等不到事件 ${label}；已有 ${JSON.stringify(events.slice(from))}`);
}

async function killChild(child) {
  child.kill();
  await new Promise((r) => {
    child.on('close', r);
    setTimeout(r, 2000);
  });
}

const postJson = (url, body, extraHeaders = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });

{
  // E-1：--yolo 全自动 + 安全闸负例
  const home4 = mkdtempSync(path.join(tmpdir(), 'gcode-smoke-web-'));
  const g = startGcode(['web', '--yolo'], { GCODE_NO_OPEN: '1', HOME: home4, USERPROFILE: home4 });
  try {
    const url = await waitUrl(g);
    const page = await fetch(url);
    assert.equal(page.status, 200, 'E1: 页面应 200');
    assert.ok((await page.text()).includes('gcode'), 'E1: 页面内容异常');

    const badToken = await fetch(url.replace(/\/t\/[^/]+\//, '/t/wrongtoken/send'), { method: 'POST' });
    assert.equal(badToken.status, 404, 'E1: 错 token 应 404');
    const badOrigin = await postJson(url + 'send', {}, { origin: 'http://evil.example' });
    assert.equal(badOrigin.status, 403, 'E1: 跨源 Origin 应 403');

    const sse = sseCollect(url);
    // 先等 SSE 握手，避免 /send 的事件发进还没注册的连接
    await waitForEvent(sse.events, (e) => e.type === 'hello', 'hello');
    const sent = await postJson(url + 'send', { text: '跑一下冒烟测试' });
    assert.equal(sent.status, 200, 'E1: /send 应受理');
    await waitForEvent(sse.events, (e) => e.type === 'user' && e.text === '跑一下冒烟测试', 'user 回显');
    await waitForEvent(sse.events, (e) => e.type === 'tool_call' && e.name === 'bash', 'tool_call');
    await waitForEvent(sse.events, (e) => e.type === 'tool_result' && e.name === 'bash', 'tool_result');
    await waitForEvent(sse.events, (e) => e.type === 'text' && (e.delta || '').includes('smoke-ok'), '最终正文');
    await waitForEvent(sse.events, (e) => e.type === 'turn_end', 'turn_end');
    sse.stop();
    console.log('冒烟E1通过：web 壳 yolo 模式全链路 + token/Origin 安全闸');
  } finally {
    await killChild(g.child);
  }
}

{
  // E-2：无 --yolo，权限确认 allow 与 deny 两轮
  const home5 = mkdtempSync(path.join(tmpdir(), 'gcode-smoke-webperm-'));
  const g = startGcode(['web'], { GCODE_NO_OPEN: '1', HOME: home5, USERPROFILE: home5 });
  try {
    const url = await waitUrl(g);
    const sse = sseCollect(url);
    await waitForEvent(sse.events, (e) => e.type === 'hello', 'hello');
    await postJson(url + 'send', { text: '跑一下冒烟测试' });
    const allow = await waitForEvent(sse.events, (e) => e.type === 'permission' && e.tool === 'bash', 'permission(allow)');
    assert.ok(allow.ev.preview.includes('echo smoke-ok'), 'E2: 预览应含将执行的命令');
    await postJson(url + 'permission', { id: allow.ev.id, decision: 'allow' });
    await waitForEvent(sse.events, (e) => e.type === 'tool_result' && e.name === 'bash', 'allow 后 tool_result', 20_000, allow.index);
    await waitForEvent(sse.events, (e) => e.type === 'turn_end', 'allow 后 turn_end', 20_000, allow.index);

    await postJson(url + 'send', { text: '再来一次' });
    const deny = await waitForEvent(sse.events, (e) => e.type === 'permission' && e.tool === 'bash', 'permission(deny)', 20_000, allow.index + 1);
    const denyResp = await postJson(url + 'permission', { id: deny.ev.id, decision: 'deny' });
    assert.equal(denyResp.status, 200, 'E2: deny POST 应 200，实际 ' + (await denyResp.text()));
    const denied = await waitForEvent(
      sse.events,
      (e) => e.type === 'tool_result' && (e.summary || '').includes('拒绝'),
      'deny 后拒绝回执',
      20_000,
      deny.index
    );
    void denied;
    await waitForEvent(sse.events, (e) => e.type === 'turn_end', 'deny 后 turn_end', 20_000, deny.index);
    sse.stop();
    console.log('冒烟E2通过：web 壳权限确认 allow/deny 两轮往返');
  } finally {
    await killChild(g.child);
  }
}

server.close();
