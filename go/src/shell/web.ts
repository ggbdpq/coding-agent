// web 壳插件：本地 HTTP 服务 + 浏览器单文件 UI。零依赖（node:http + 原生 EventSource）。
// 信任边界安全闸（不可省）：只绑 127.0.0.1；URL 携带随机 token；Host/Origin 双校验——
// 浏览器里任何网页都能对 localhost 端口发 POST，没有这两道闸等于网页可远程触发命令执行。
// ponytail: 单会话单服务、无鉴权体系、不自动开浏览器（打印 URL 自己点）；多会话/认证
// 等真实需求出现再加。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPermissionGate, type PermissionDecision } from '../core/permission.ts';
import { runUserTurn } from '../core/turn.ts';
import { VERSION, type App } from '../kernel/app.ts';
import { definePlugin } from '../kernel/plugin.ts';

const BODY_LIMIT = 1024 * 1024;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startWeb(app: App): Promise<void> {
  const token = randomBytes(12).toString('base64url');
  const page = readFileSync(new URL('./web.html', import.meta.url), 'utf8');

  const sseClients = new Set<ServerResponse>();
  const sendEvent = (ev: Record<string, unknown>) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sseClients) res.write(line);
  };

  // 权限 UI 适配：发 permission 事件带 id，等 /permission 端点回传三态决定
  const pending = new Map<string, (d: PermissionDecision) => void>();
  let permSeq = 0;
  const gate = createPermissionGate(
    {
      ask: ({ tool, preview }) =>
        new Promise((resolve) => {
          const id = `p${++permSeq}`;
          pending.set(id, resolve);
          sendEvent({ type: 'permission', id, tool, preview });
        }),
    },
    app.yolo
  );

  // ponytail: 命令插件以 console.log 输出，这里临时接管收进缓冲返回给浏览器；
  // 要更干净就给 App 加输出通道，等更多消费方出现再抽象
  let captureBuf: string[] | null = null;
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    if (captureBuf) captureBuf.push(a.map(String).join(' '));
    else origLog(...a);
  };

  let busy = false;
  let abort: AbortController | null = null;

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let buf = '';
      req.on('data', (d: Buffer) => {
        buf += d;
        if (buf.length > BODY_LIMIT) {
          reject(new Error('请求体过大'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(buf));
      req.on('error', reject);
    });

  async function runTurnAsync(text: string): Promise<void> {
    busy = true;
    abort = new AbortController();
    sendEvent({ type: 'user', text });
    try {
      await runUserTurn(app, text, {
        check: gate,
        signal: abort.signal,
        onText: (delta) => sendEvent({ type: 'text', delta }),
        onToolCall: (name, args) => sendEvent({ type: 'tool_call', name, args }),
        onToolResult: (name, result, ms) =>
          sendEvent({ type: 'tool_result', name, summary: result.split('\n')[0], ms }),
        onTrimmed: (count) => sendEvent({ type: 'trimmed', count }),
      });
      sendEvent({ type: 'turn_end' });
    } catch (e) {
      if ((e as Error).name === 'AbortError') sendEvent({ type: 'aborted' });
      else sendEvent({ type: 'error', message: (e as Error).message });
      sendEvent({ type: 'turn_end' });
    } finally {
      busy = false;
      abort = null;
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(403).end('forbidden host');
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      res.writeHead(403).end('forbidden origin');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const m = url.pathname.match(/^\/t\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (!m || m[1] !== token) {
      res.writeHead(404).end('not found');
      return;
    }
    const path = m[2] ?? '/';

    if (req.method === 'GET' && (path === '/' || path === '')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return;
    }
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(
        `data: ${JSON.stringify({ type: 'hello', model: app.config.model, yolo: app.yolo.value, version: VERSION })}\n\n`
      );
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && path === '/send') {
      if (busy) {
        json(res, 409, { error: '上一轮还在跑，先停止或等它结束' });
        return;
      }
      const body = JSON.parse(await readBody(req)) as { text?: string };
      const text = String(body.text ?? '').trim();
      if (!text) {
        json(res, 400, { error: '空输入' });
        return;
      }
      json(res, 200, { ok: true });
      void runTurnAsync(text);
      return;
    }
    if (req.method === 'POST' && path === '/permission') {
      const body = JSON.parse(await readBody(req)) as { id?: string; decision?: string };
      const id = String(body.id ?? '');
      const decision = body.decision;
      const resolve = pending.get(id);
      if (!resolve || (decision !== 'allow' && decision !== 'deny' && decision !== 'always')) {
        json(res, 404, { error: '没有这个待确认请求' });
        return;
      }
      pending.delete(id);
      resolve(decision);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/abort') {
      abort?.abort();
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/command') {
      const body = JSON.parse(await readBody(req)) as { line?: string };
      const line = String(body.line ?? '').trim();
      const [rawCmd, ...args] = line.replace(/^\//, '').split(/\s+/);
      const cmd = app.registry.commands().find((c) => c.name === rawCmd);
      if (!cmd) {
        json(res, 404, { error: `未知命令 /${rawCmd}，/help 查看可用命令` });
        return;
      }
      captureBuf = [];
      try {
        const outcome = await cmd.run(app, args);
        const output = (captureBuf ?? []).join('\n').replace(ANSI_RE, '');
        json(res, 200, {
          output,
          exit: outcome?.exit === true,
          reset: rawCmd === 'new' || rawCmd === 'resume',
          yolo: app.yolo.value,
        });
        if (outcome?.exit) setTimeout(() => process.exit(0), 200);
      } finally {
        captureBuf = null;
      }
      return;
    }
    res.writeHead(404).end('not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: Error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/t/${token}/`;
  console.log(`gcode web v${VERSION} · ${app.config.model} · ${process.cwd()}`);
  console.log(url);
  console.log('浏览器打开上面地址即可使用；Ctrl+C 退出服务');
  // 心跳防中间层断连；unref 不阻止进程退出
  const ping = setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n');
  }, 25_000);
  ping.unref();
}

export default definePlugin({ name: 'web', kind: 'shell', start: startWeb });
