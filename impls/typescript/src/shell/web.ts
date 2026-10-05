// web 壳插件：本地 HTTP 服务 + 浏览器单文件 UI。零依赖（node:http + 原生 EventSource）。
// 信任边界安全闸（不可省）：只绑 127.0.0.1；URL 携带随机 token；Host/Origin 双校验——
// 浏览器里任何网页都能对 localhost 端口发 POST，没有这两道闸等于网页可远程触发命令执行。
// 同一服务仅运行一个项目的一轮任务；历史会话复用 JSONL，不另建数据库。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, lstatSync, existsSync, mkdirSync, writeFileSync, renameSync, realpathSync, unlinkSync } from 'node:fs';
import nodePath from 'node:path';
import { createPermissionGate, type PermissionDecision } from '../core/permission.ts';
import { runUserTurn } from '../core/turn.ts';
import type { AgentEvent } from '../kernel/types.ts';
import { VERSION, selectProvider, type App } from '../kernel/app.ts';
import { saveWebConfig, saveModelProfile, selectModelProfile, deleteModelProfile, importModelProfiles, saveMcpServer, deleteMcpServer, saveWorkspace, saveProjectArchive, removeProject, saveWebPreferences, ConfigInputError } from '../kernel/config.ts';
import { SessionStore } from '../core/session.ts';
import type { ChatMessage } from '../kernel/types.ts';
import { definePlugin } from '../kernel/plugin.ts';
import { appendJournal, journalError, loadJournal, resetJournal, saveJournal, setFileJournalSink } from '../plugins/tools/filejournal.ts';
import { commitStaged, revertToEntry, stagePaths, workspaceChanges, type ChangesResult } from './webgit.ts';
import { buildSystemPrompt, discoverSkills } from '../core/systemprompt.ts';
import { AutomationRunner } from '../core/automation.ts';
import { McpManager } from '../core/mcp.ts';
import { setSessionCwd } from '../plugins/tools/pathguard.ts';
import { mergedCatalog } from '../core/mcp_catalog.ts';
import { fetchBalance, listModels } from '../providers/models.ts';
import { pickWorkspace } from './workspacepicker.ts';

const BODY_LIMIT = 1024 * 1024;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startWeb(app: App): Promise<void> {
  if (!(app.store instanceof SessionStore)) throw new Error('Web 工作台需要 SessionStore');
  const store = app.store;
  const token = randomBytes(12).toString('base64url');
  const page = readFileSync(new URL('./web.html', import.meta.url), 'utf8');

  const sseClients = new Set<ServerResponse>();
  const activity: Record<string, unknown>[] = [];
  let seq = 0;
  let status = 'idle';
  let turnId: string | null = null;
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let storageError: string | undefined;
  let pickerOpen = false;
  const safeError = (message: string, config = app.config) => [config.apiKey, ...(config.modelProfiles ?? []).map((profile) => profile.apiKey)]
    .filter(Boolean).sort((a, b) => b.length - a.length).reduce((text, key) => text.split(key).join('[凭证已隐藏]'), message);
  const modelProvider = (config: typeof app.config) => {
    try { return selectProvider(config, app.registry); }
    catch (error) { throw new Error(safeError((error as Error).message, config)); }
  };
  const sendEvent = (ev: Record<string, unknown>) => {
    const packet = { ...ev, seq: ++seq, sessionId: store.currentId };
    if (!['state', 'error', 'aborted'].includes(String(ev.type))) {
      activity.push(packet);
      try { store.appendActivity(packet); }
      catch { storageError = '本地会话保存失败，请检查数据目录的空间和权限'; }
    }
    const line = `data: ${JSON.stringify(packet)}\n\n`;
    for (const res of sseClients) res.write(line);
  };

  // 权限 UI 适配：发 permission 事件带 id，等 /permission 端点回传三态决定
  const pending = new Map<string, (d: PermissionDecision) => void>();
  let permSeq = 0;
  const permissions = new Map<string, Record<string, unknown>>();
  const gate = createPermissionGate(
    {
      ask: ({ tool, preview }) =>
        new Promise((resolve, reject) => {
          const id = `p${++permSeq}`;
          const signal = abort?.signal;
          const cancel = () => {
            pending.delete(id);
            permissions.delete(id);
            reject(new DOMException('用户已停止', 'AbortError'));
          };
          if (signal?.aborted) { cancel(); return; }
          signal?.addEventListener('abort', cancel, { once: true });
          pending.set(id, (decision) => {
            permissions.delete(id);
            signal?.removeEventListener('abort', cancel);
            if (signal?.aborted) cancel();
            else resolve(decision);
          });
          status = 'waiting_approval';
          const request = { type: 'permission', id, tool, preview };
          permissions.set(id, request);
          sendEvent(request);
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

  // 自动化任务：隔离会话后台执行，定义与状态持久化在数据目录 automations/
  const automations = new AutomationRunner(app.config.tcodeDir);
  // 外部 MCP 工具服务器：启用的服务器工具桥接进每轮工具列表
  const mcp = new McpManager();
  app.mcpTools = () => mcp.toolPlugins(app.config.mcpServers ?? [], process.cwd());
  // 会话工作目录注入：与进程 cwd 同步设置（单会话语义），显式化路径解析的所有权
  setSessionCwd(app.config.workspace ?? process.cwd());
  // 启动时预热启用的服务器连接（完成后刷新工具列表）
  void Promise.all((app.config.mcpServers ?? []).filter((server) => server.enabled)
    .map((server) => mcp.test(server, process.cwd()).catch(() => {}))).then(() => { refreshSystemPrompt(); sendState(); });

  // 写前快照日志：记录本轮 agent 通过 edit/write/apply_patch 修改的文件原文，支撑"撤销本轮修改"。
  // bash 写入无法归因，不在快照范围；日志按会话落盘，重启后仍可撤销上一轮。
  setFileJournalSink({
    append: (entry) => appendJournal(app.config.tcodeDir, store.currentId ?? 'unknown', entry),
  });
  const journalEntries = () => loadJournal(app.config.tcodeDir, store.currentId ?? 'unknown');
  const changesSnapshot = async (): Promise<ChangesResult> => {
    const result = await workspaceChanges(app.config.workspace ?? process.cwd(),
      new Map(journalEntries().map((entry) => [entry.path, entry])));
    const failure = journalError();
    if (failure) result.journalError = failure;
    return result;
  };

  function fromMessages(messages: ChatMessage[]): Record<string, unknown>[] {
    return messages.flatMap((message) => {
      if (message.role === 'user') return [{ type: 'user', text: message.content ?? '' }];
      if (message.role === 'tool') return [{ type: 'tool_result', call_id: message.tool_call_id, name: 'tool', output: message.content ?? '', summary: (message.content ?? '').split('\n')[0], ms: 0 }];
      if (message.role !== 'assistant') return [];
      const result: Record<string, unknown>[] = message.content ? [{ type: 'text', delta: message.content }] : [];
      for (const call of message.tool_calls ?? []) {
        let args = {}; try { args = JSON.parse(call.function.arguments); } catch {}
        result.push({ type: 'tool_call', call_id: call.id, name: call.function.name, args });
      }
      return result;
    });
  }

  function replaceActivity(events: Record<string, unknown>[], persist = true) {
    activity.length = 0; usage = { prompt_tokens: 0, completion_tokens: 0 };
    status = 'idle'; turnId = null; storageError = undefined;
    for (const event of events) {
      seq = Math.max(seq, Number(event.seq) || 0);
      if (event.type === 'usage') {
        usage.prompt_tokens += Number(event.prompt_tokens) || 0;
        usage.completion_tokens += Number(event.completion_tokens) || 0;
      }
      if (event.type === 'turn_start') turnId = String(event.id);
      if (event.type === 'turn_end') status = String(event.reason);
      activity.push(event); if (persist) store.appendActivity(event);
    }
    const lastStart = events.findLastIndex((event) => event.type === 'turn_start');
    const lastEnd = events.findLastIndex((event) => event.type === 'turn_end');
    if (lastStart > lastEnd) {
      status = 'aborted';
      sendEvent({ type: 'turn_end', reason: 'aborted', error: '服务重启，上轮执行已中断' });
    }
  }

  function activate(id: string, workspace = app.config.workspace ?? process.cwd(), commitWorkspace?: () => void) {
    const history = store.history(id, workspace);
    const messages = history.messages.filter((message) => message.role !== 'system');
    const lastStart = history.activity.findLastIndex((event) => event.type === 'turn_start');
    const lastEnd = history.activity.findLastIndex((event) => event.type === 'turn_end');
    if (lastStart > lastEnd) {
      // 强制退出时消息可能尚未落盘；回放本轮已保存事件，工具无结果时明确标记未知。
      const tail: ChatMessage[] = [];
      let assistant: ChatMessage | undefined;
      const flush = () => { if (assistant) tail.push(assistant); assistant = undefined; };
      for (const event of history.activity.slice(lastStart)) {
        if (event.type === 'user') { flush(); tail.push({ role: 'user', content: String(event.text ?? '') }); }
        if (event.type === 'text') {
          assistant ??= { role: 'assistant', content: '' };
          assistant.content = (assistant.content ?? '') + String(event.delta ?? '');
        }
        if (event.type === 'tool_call') {
          assistant ??= { role: 'assistant', content: '' };
          (assistant.tool_calls ??= []).push({ id: String(event.call_id), type: 'function', function: { name: String(event.name), arguments: JSON.stringify(event.args ?? {}) } });
        }
        if (event.type === 'tool_result') { flush(); tail.push({ role: 'tool', tool_call_id: String(event.call_id), content: String(event.output ?? event.summary ?? '') }); }
      }
      flush();
      const lastBatch = tail.findLastIndex((message) => message.role === 'assistant' && message.tool_calls?.length);
      const answered = new Set(tail.slice(lastBatch + 1).filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
      for (const call of tail[lastBatch]?.tool_calls ?? []) {
        if (!answered.has(call.id)) tail.push({ role: 'tool', tool_call_id: call.id, content: '（服务中断，执行结果未知；请先检查文件或命令结果）' });
      }
      // 消息落盘与终态事件之间也可能退出，已有本轮消息时替换断尾，避免重复目标。
      if (history.pendingTurnPersisted) {
        messages.splice(messages.findLastIndex((message) => message.role === 'user'));
      }
      messages.push(...tail);
    }
    const events = history.activity.length ? [...history.activity] : fromMessages(messages);
    if (lastStart > lastEnd) {
      events.push({ type: 'turn_end', reason: 'aborted', error: '服务重启，上轮执行已中断', sessionId: id,
        seq: events.reduce((latest, event) => Math.max(latest, Number(event.seq) || 0), seq) + 1 });
    }
    app.startSession({ sessionId: id, cwd: workspace, resumedFrom: history.file.split(/[\\/]/).pop(), yolo: app.config.approval === 'never' }, { messages, activity: events }, commitWorkspace);
    resetModes(); app.resetMessages(); app.messages.push(...messages);
    replaceActivity(events, false);
  }

  function resetModes() {
    app.yolo.value = app.config.approval === 'never';
    app.planMode.value = false;
  }

  function skillDirectories() {
    return [nodePath.join(app.config.tcodeDir, 'skills'), nodePath.join(app.config.workspace ?? process.cwd(), '.tcode', 'skills')];
  }

  function skillFile(scope: unknown, name: unknown) {
    if (scope !== 'global' && scope !== 'project') throw new ConfigInputError('技能范围须为 global 或 project');
    if (scope === 'project' && app.config.workspace === '') throw new ConfigInputError('请先选择项目');
    if (typeof name !== 'string' || !/^[\p{L}\p{N}_-][\p{L}\p{N} _.-]{0,99}\.md$/u.test(name)) throw new ConfigInputError('技能名称须为 .md 文件名，不能含目录');
    const dir = skillDirectories()[scope === 'global' ? 0 : 1]!;
    const parent = nodePath.dirname(dir);
    const anchor = scope === 'global' ? app.config.tcodeDir : app.config.workspace ?? process.cwd();
    if ((existsSync(parent) && lstatSync(parent).isSymbolicLink()) || (existsSync(dir) && lstatSync(dir).isSymbolicLink())) throw new ConfigInputError('技能目录不能是符号链接');
    if (existsSync(dir) && !realpathSync(dir).startsWith(realpathSync(anchor) + nodePath.sep)) throw new ConfigInputError('技能目录越界');
    const file = nodePath.join(dir, name);
    try { if (!lstatSync(file).isFile()) throw new ConfigInputError('技能文件须为普通文件'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { dir, file, name };
  }

  function refreshSystemPrompt() {
    const marker = '\n# Plan Mode（当前生效）';
    const previous = app.messages[0]?.content ?? '';
    const plan = app.planMode.value && previous.includes(marker) ? previous.slice(previous.indexOf(marker)) : '';
    app.messages[0] = { role: 'system', content: buildSystemPrompt(app.config.workspace ?? process.cwd(), undefined, app.config.tcodeDir) + plan + mcp.promptSection(app.config.mcpServers ?? []) };
  }

  if (app.messages.length > 1) replaceActivity(fromMessages(app.messages));
  else {
    const cwd = app.config.workspace ?? process.cwd();
    const recent = cwd && store.listWorkspace(cwd).find((session) => session.id !== store.currentId && session.label);
    if (recent) activate(recent.id);
  }

  function snapshot() {
    const { baseUrl, model, protocol, contextLimit, apiKey, workspace, configError } = app.config;
    const cwd = workspace ?? process.cwd();
    const sessions = cwd ? store.listWorkspace(cwd)
      .filter((session) => session.label || session.id === store.currentId)
      .map(({ file: _file, ...session }) => session) : [];
    const projectList = [...new Set([...(app.config.projects ?? []), ...(app.config.archivedProjects ?? []), ...(cwd ? [cwd] : [])])].map((directory) => {
      let available = false; try { available = statSync(directory).isDirectory(); } catch {}
      return { path: directory, name: nodePath.basename(directory) || directory, available,
        sessionCount: store.listWorkspace(directory).filter((session) => session.label).length };
    });
    const archived = new Set((app.config.archivedProjects ?? []).filter((directory) => directory !== cwd));
    return { ready: !!(apiKey && baseUrl && model && cwd && !configError), projects: projectList.filter((project) => !archived.has(project.path)),
      archivedProjects: projectList.filter((project) => archived.has(project.path)),
      version: VERSION, dataDir: app.config.tcodeDir,
      modelProfiles: (app.config.modelProfiles ?? []).map(({ id, name, baseUrl, model, protocol, contextLimit, apiKey, keyRef }) => ({ id, name, baseUrl, model, protocol: protocol ?? 'auto', contextLimit, hasApiKey: !!(apiKey || keyRef) })),
      activeModelProfileId: app.config.activeModelProfileId ?? null,
      preferences: app.config.preferences ?? { theme: 'system', fontSize: 16, enterToSend: true },
      capabilities: {
        commands: app.registry.commands().map((command) => ({ name: command.name, usage: command.usage, description: command.summary })),
        tools: [...app.registry.tools(), ...(app.mcpTools?.() ?? [])].map((tool) => ({ name: tool.name, description: tool.description })),
        mcpServers: (app.config.mcpServers ?? []).map(({ env: _env, ...safe }) => safe),
        skills: skillDirectories().flatMap((dir, index) => index && app.config.workspace === '' ? [] : discoverSkills([dir]).map((skill) => ({ ...skill, scope: index ? 'project' : 'global' }))),
      },
      config: { baseUrl, model, protocol: protocol ?? 'auto', contextLimit, workspace: cwd, hasApiKey: !!apiKey,
        approval: app.config.approval ?? 'normal', allowWriteDirs: app.config.allowWriteDirs ?? [] },
      configError, storageError, currentSessionId: store.currentId, title: sessions.find((session) => session.id === store.currentId)?.title ?? '新会话', sessions,
      messages: app.messages.filter((message) => message.role !== 'system'), activity, status, busy,
      yolo: app.yolo.value, planMode: app.planMode.value, pending: [...permissions.values()], usage, turnId, seq,
    };
  }

  function switchWorkspace(next: typeof app.config) {
    const changed = next.workspace !== (app.config.workspace ?? process.cwd());
    if (next.workspace) process.chdir(next.workspace);
    setSessionCwd(next.workspace ?? null);
    Object.assign(app.config, next);
    if (changed) {
      resetModes(); app.resetMessages(); app.startSession(); replaceActivity([]);
      const recent = store.listWorkspace(process.cwd()).find((session) => session.id !== store.currentId && session.label);
      if (recent) activate(recent.id);
    }
  }

  function sendState() {
    const packet = { type: 'state', seq: ++seq, state: snapshot() };
    const line = `data: ${JSON.stringify(packet)}\n\n`;
    for (const res of sseClients) res.write(line);
  }

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

  /** EventBridge：规范 AgentEvent → 浏览器线协议（保持既有 SSE 事件名不变） */
  function bridgeEvent(ev: AgentEvent): void {
    switch (ev.type) {
      case 'turn_start':
        turnId = ev.id; status = 'running'; sendEvent(ev); break;
      case 'user':
        sendEvent({ type: 'user', text: ev.text });
        break;
      case 'text_delta':
        sendEvent({ type: 'text', delta: ev.delta });
        break;
      case 'tool_call':
        sendEvent({ type: 'tool_call', call_id: ev.call_id, name: ev.name, args: ev.args });
        break;
      case 'tool_result':
        sendEvent({ ...ev });
        break;
      case 'usage':
        usage.prompt_tokens += ev.prompt_tokens;
        usage.completion_tokens += ev.completion_tokens;
        sendEvent(ev); break;
      case 'compact': sendEvent(ev); break;
      case 'trimmed':
        sendEvent({ type: 'trimmed', count: ev.count });
        break;
      case 'turn_end':
        status = ev.reason;
        if (ev.reason === 'aborted') sendEvent({ type: 'aborted' });
        else if (ev.reason === 'error') sendEvent({ type: 'error', message: safeError(ev.error ?? '未知错误') });
        sendEvent({ ...ev, error: ev.error ? safeError(ev.error) : undefined });
        break;
      default:
        break;
    }
  }

  /** 生命周期钩子：以用户权限在项目目录执行配置的 shell 命令，输出回显会话；失败可见不阻塞 */
  async function runHook(event: 'beforeTurn' | 'afterTurn', status: string): Promise<void> {
    const command = (event === 'beforeTurn' ? app.config.beforeTurn : app.config.afterTurn)?.trim();
    if (!command) return;
    const label = event === 'beforeTurn' ? '轮开始钩子' : '轮结束钩子';
    try {
      const executed = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        const child = spawn(command, {
          shell: true,
          cwd: app.config.workspace ?? process.cwd(),
          env: { ...process.env, TCODE_HOOK_EVENT: event, TCODE_HOOK_STATUS: status, TCODE_HOOK_CWD: app.config.workspace ?? process.cwd() },
          timeout: 30_000,
        });
        let text = '';
        child.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
        child.on('close', (code) => resolve({ code, text: text.slice(-2000) }));
        child.on('error', reject);
      });
      const output = executed.text.trim();
      if (executed.code !== 0) sendEvent({ type: 'command', output: `${label}执行失败（code ${executed.code}）${output ? '\n' + output : ''}` });
      else if (output) sendEvent({ type: 'command', output: `${label}输出：\n${output}` });
    } catch (error) {
      sendEvent({ type: 'command', output: `${label}执行失败：${(error as Error).message}` });
    }
  }

  const runAfterTurnHook = (status: string) => runHook('afterTurn', status);

  async function runTurnAsync(text: string): Promise<void> {
    busy = true;
    abort = new AbortController();
    resetJournal(app.config.tcodeDir, store.currentId ?? 'unknown');
    await runHook('beforeTurn', 'beforeTurn');
    try {
      // MCP 工具桥接就绪（连接预热完成或 2 秒上限）后再组装本轮工具
      await Promise.race([
        Promise.all((app.config.mcpServers ?? []).filter((server) => server.enabled)
          .map((server) => mcp.test(server, process.cwd()).catch(() => {}))),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      let turnStatus: string = 'completed';
      await runUserTurn(app, text, {
        check: gate,
        signal: abort.signal,
        emit: bridgeEvent,
      }).catch((error: Error) => { turnStatus = error.name === 'AbortError' ? 'aborted' : 'error'; });
      void runAfterTurnHook(turnStatus);
    } finally {
      busy = false;
      abort = null;
      pending.clear(); permissions.clear();
      sendState();
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

    // 读取请求体可能让出执行权；全部状态检查必须在读取之后，检查到执行间不再 await。
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      try {
        const value = JSON.parse(await readBody(req)) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        body = value as Record<string, unknown>;
      } catch { json(res, 400, { error: '请求须为 JSON 对象' }); return; }
    }

    if (req.method === 'GET' && path === '/state') { json(res, 200, snapshot()); return; }
    if (req.method === 'POST' && path === '/sessions/search') {
      if (typeof body.query !== 'string' || body.query.length > 200) throw new ConfigInputError('搜索内容须为不超过 200 个字符的文本');
      const result = store.search(body.query);
      json(res, 200, { ...result, sessions: result.sessions.map((session) => {
        let available = false; try { available = statSync(session.cwd).isDirectory(); } catch {}
        return { ...session, archived: (app.config.archivedProjects ?? []).includes(session.cwd), available };
      }) }); return;
    }
    if (req.method === 'GET' && path === '/usage') {
      const sessions = store.listWorkspace().filter((session) => session.label);
      const inputTokens = sessions.reduce((total, session) => total + session.usage.prompt_tokens, 0);
      const outputTokens = sessions.reduce((total, session) => total + session.usage.completion_tokens, 0);
      json(res, 200, { sessions: sessions.length, projects: new Set(sessions.map((session) => session.cwd)).size,
        inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }); return;
    }
    if (req.method === 'GET' && path === '/skills') {
      const skill = skillFile(url.searchParams.get('scope'), url.searchParams.get('name'));
      if (!existsSync(skill.file)) { json(res, 404, { error: '技能不存在' }); return; }
      if (statSync(skill.file).size > 256 * 1024) throw new ConfigInputError('技能正文超过 256KB，无法在设置中编辑');
      json(res, 200, { name: skill.name, content: readFileSync(skill.file, 'utf8') }); return;
    }
    if (req.method === 'POST' && path === '/skills') {
      if (busy) { json(res, 409, { error: '任务运行期间不能修改技能' }); return; }
      const skill = skillFile(body.scope, body.name);
      if (typeof body.content !== 'string' || !body.content.trim() || Buffer.byteLength(body.content) > 256 * 1024) throw new ConfigInputError('技能正文须为非空文本，且不超过 256KB');
      mkdirSync(skill.dir, { recursive: true, mode: 0o700 });
      const temporary = nodePath.join(skill.dir, `.${randomBytes(8).toString('hex')}.tmp`);
      writeFileSync(temporary, body.content, { mode: 0o600, flag: 'wx' }); renameSync(temporary, skill.file);
      refreshSystemPrompt();
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'GET' && path === '/changes') {
      json(res, 200, await changesSnapshot()); return;
    }
    if (req.method === 'POST' && path === '/changes/revert') {
      if (busy) { json(res, 409, { error: '任务运行期间不能撤销修改' }); return; }
      if (typeof body.path !== 'string' || !body.path) throw new ConfigInputError('请提供要撤销的文件路径');
      const absolute = nodePath.resolve(app.config.workspace ?? process.cwd(), body.path);
      const entries = journalEntries().filter((entry) => entry.path === absolute);
      if (!entries.length) { json(res, 404, { error: '该文件没有本轮修改快照；只有 Agent 本轮通过编辑/写入工具改动的文件可撤销' }); return; }
      if (await revertToEntry(entries) === 'conflict') {
        json(res, 409, { error: '文件在快照之后又被修改（可能是你手动编辑的），为保护你的改动未执行撤销；可用 Git 对比后自行处理' });
        return;
      }
      saveJournal(app.config.tcodeDir, store.currentId ?? 'unknown', journalEntries().filter((entry) => entry.path !== absolute));
      json(res, 200, { ok: true, changes: await changesSnapshot() }); return;
    }
    if (req.method === 'POST' && path === '/changes/stage') {
      if (busy) { json(res, 409, { error: '任务运行期间不能修改暂存区' }); return; }
      const paths = body.paths;
      if (!Array.isArray(paths) || !paths.length || paths.length > 50 || paths.some((item) => typeof item !== 'string' || !item)) {
        throw new ConfigInputError('paths 须为 1–50 个变更文件路径');
      }
      if (typeof body.staged !== 'boolean') throw new ConfigInputError('staged 须为布尔值');
      try { await stagePaths(app.config.workspace ?? process.cwd(), paths as string[], body.staged); }
      catch (error) {
        if (error instanceof RangeError) throw new ConfigInputError(error.message);
        throw error;
      }
      json(res, 200, { ok: true, changes: await changesSnapshot() }); return;
    }
    if (req.method === 'POST' && path === '/changes/commit') {
      if (busy) { json(res, 409, { error: '任务运行期间不能提交' }); return; }
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message || message.length > 2000) throw new ConfigInputError('提交说明须为 1–2000 个字符');
      try { await commitStaged(app.config.workspace ?? process.cwd(), message); }
      catch (error) {
        if (error instanceof RangeError) { json(res, 409, { error: error.message }); return; }
        // git 失败（如未配置提交身份、hook 拒绝）原样转述，便于用户在终端处理
        throw new Error(`提交失败：${(error as Error).message}`);
      }
      json(res, 200, { ok: true, changes: await changesSnapshot() }); return;
    }
    if (req.method === 'POST' && path === '/workspace') {
      if (busy) { json(res, 409, { error: '任务运行期间不能切换项目' }); return; }
      switchWorkspace(saveWorkspace(app.config, body.workspace));
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'POST' && path === '/projects/archive') {
      if (busy) { json(res, 409, { error: '任务运行期间不能归档或恢复项目' }); return; }
      if (typeof body.workspace !== 'string' || !nodePath.isAbsolute(body.workspace) || typeof body.archived !== 'boolean') {
        throw new ConfigInputError('项目须为绝对路径，归档状态须为布尔值');
      }
      let directory = nodePath.resolve(body.workspace);
      try { directory = realpathSync(directory); } catch {}
      if (body.archived && directory === app.config.workspace) { json(res, 409, { error: '当前项目不能归档，请先切换项目' }); return; }
      Object.assign(app.config, saveProjectArchive(app.config, directory, body.archived));
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'POST' && path === '/projects/remove') {
      if (busy) { json(res, 409, { error: '任务运行期间不能移除项目' }); return; }
      if (typeof body.workspace !== 'string' || !nodePath.isAbsolute(body.workspace)) {
        throw new ConfigInputError('项目须为绝对路径');
      }
      let directory = nodePath.resolve(body.workspace);
      try { directory = realpathSync(directory); } catch {}
      if (directory === app.config.workspace) { json(res, 409, { error: '当前项目不能移除，请先切换项目' }); return; }
      Object.assign(app.config, removeProject(app.config, directory));
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'POST' && path === '/workspace/pick') {
      if (busy || pickerOpen) { json(res, 409, { error: '任务或目录选择器正在运行' }); return; }
      pickerOpen = true;
      try { json(res, 200, { workspace: await pickWorkspace() }); }
      finally { pickerOpen = false; }
      return;
    }
    if (req.method === 'POST' && path === '/preferences') {
      if (busy) { json(res, 409, { error: '任务运行期间不能修改设置' }); return; }
      Object.assign(app.config, saveWebPreferences(app.config, body));
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'GET' && path === '/model/discover') {
      if (busy) { json(res, 409, { error: '任务运行期间不能获取模型列表' }); return; }
      if (!app.config.apiKey || !app.config.baseUrl || !app.config.model) {
        throw new ConfigInputError('请先保存有效的模型配置');
      }
      // 协议与 selectProvider 同源：显式 protocol 优先，否则按 URL 自动识别（anthropic 匹配 /anthropic）
      const auto = app.registry.providers().find((entry) => entry.matches(app.config.baseUrl))?.name === 'anthropic' ? 'anthropic' : 'openai';
      const protocol = app.config.protocol === 'anthropic' || app.config.protocol === 'openai' ? app.config.protocol : auto;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const models = await listModels(app.config.baseUrl, app.config.apiKey, protocol, controller.signal);
        json(res, 200, { models });
      } catch (error) {
        if (controller.signal.aborted) { json(res, 504, { error: '获取模型列表超时（10 秒）' }); return; }
        // 先遮蔽凭证再截断；半截密钥不能出现在错误里
        json(res, 502, { error: safeError((error as Error).message).slice(0, 400) });
      } finally {
        clearTimeout(timer);
      }
      return;
    }
    if (req.method === 'GET' && path === '/mcp/catalog') {
      const merged = mergedCatalog(app.config.tcodeDir);
      json(res, 200, { catalog: merged.catalog, userCount: merged.userCount, ...(merged.catalogError ? { catalogError: merged.catalogError } : {}) });
      return;
    }
    if (req.method === 'POST' && path === '/mcp/servers') {
      if (busy) { json(res, 409, { error: '任务运行期间不能修改 MCP 服务器' }); return; }
      Object.assign(app.config, saveMcpServer(app.config, body));
      mcp.shutdown(String(body.id ?? '')); // 配置变更后旧连接与工具缓存作废
      refreshSystemPrompt();
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'POST' && path === '/mcp/servers/delete') {
      if (busy) { json(res, 409, { error: '任务运行期间不能删除 MCP 服务器' }); return; }
      const id = String(body.id ?? '');
      Object.assign(app.config, deleteMcpServer(app.config, id));
      mcp.shutdown(id);
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'POST' && path === '/mcp/servers/enabled') {
      if (busy) { json(res, 409, { error: '任务运行期间不能修改 MCP 服务器' }); return; }
      const id = String(body.id ?? '');
      const server = (app.config.mcpServers ?? []).find((entry) => entry.id === id);
      if (!server) { json(res, 404, { error: '没有这个 MCP 服务器' }); return; }
      if (typeof body.enabled !== 'boolean') throw new ConfigInputError('enabled 须为布尔值');
      Object.assign(app.config, saveMcpServer(app.config, { ...server, enabled: body.enabled }));
      mcp.shutdown(id);
      refreshSystemPrompt();
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'POST' && path === '/mcp/test') {
      const id = String(body.id ?? '');
      const server = (app.config.mcpServers ?? []).find((entry) => entry.id === id);
      if (!server) { json(res, 404, { error: '没有这个 MCP 服务器' }); return; }
      const previousStatus = status;
      busy = true; status = 'running'; sendState();
      try {
        const result = await mcp.test(server, process.cwd());
        status = previousStatus;
        json(res, 200, result);
      } catch (error) {
        status = previousStatus;
        json(res, 502, { error: safeError((error as Error).message) });
      } finally {
        busy = false;
        sendState();
      }
      return;
    }
    if (req.method === 'GET' && path === '/automations') {
      json(res, 200, { automations: automations.list() }); return;
    }
    const broadcastAutomation = (payload: Record<string, unknown>) => {
      const line = `data: ${JSON.stringify({ ...payload, seq: ++seq })}\n\n`;
      for (const res of sseClients) res.write(line);
    };
    const runAutomation = (id: string, continueTask = false) => {
      void automations.execute(app, id, { continueTask, onFinished: (task) => {
        if (task.status === 'interrupted') return;
        broadcastAutomation({ type: 'automation', id, name: task.name, status: task.status, resultText: task.resultText });
      } }).then(() => broadcastAutomation({ type: 'automation', id, status: automations.get(id)?.status })).catch(() => {});
    };
    if (req.method === 'POST' && path === '/automations') {
      if (!app.config.apiKey || !app.config.baseUrl || !app.config.model) {
        throw new ConfigInputError('请先保存有效的模型配置');
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!name || name.length > 80) throw new ConfigInputError('任务名称须为 1–80 个字符');
      if (!prompt || prompt.length > 20000) throw new ConfigInputError('任务提示词须为 1–20000 个字符');
      if (body.workspace !== undefined && body.workspace !== app.config.workspace) {
        throw new ConfigInputError('自动化任务当前仅支持在当前项目运行');
      }
      const intervalMinutes = body.intervalMinutes === undefined ? undefined : Number(body.intervalMinutes);
      if (intervalMinutes !== undefined && (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 525600)) {
        throw new ConfigInputError('重复执行间隔须为 5–525600 分钟的整数');
      }
      if (automations.anyRunning()) { json(res, 409, { error: '已有自动化任务正在运行（与主会话共用工作目录基准），请等待完成或先停止' }); return; }
      const task = automations.create({ name, prompt, workspace: app.config.workspace ?? process.cwd(), intervalMinutes });
      runAutomation(task.id);
      json(res, 200, { ok: true, id: task.id }); return;
    }
    if (req.method === 'POST' && path === '/automations/schedule') {
      const id = String(body.id ?? '');
      if (!automations.get(id)) { json(res, 404, { error: '没有这个自动化任务' }); return; }
      if (typeof body.paused !== 'boolean') throw new ConfigInputError('paused 须为布尔值');
      automations.setSchedule(id, { paused: body.paused });
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && path === '/automations/stop') {
      if (!automations.stop(String(body.id ?? ''))) { json(res, 404, { error: '没有正在运行的自动化任务' }); return; }
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && path === '/automations/delete') {
      const outcome = automations.remove(String(body.id ?? ''));
      if (outcome === 'running') { json(res, 409, { error: '任务正在运行，停止后才能删除' }); return; }
      if (outcome === 'missing') { json(res, 404, { error: '没有这个自动化任务' }); return; }
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && path === '/automations/resume') {
      if (!app.config.apiKey || !app.config.baseUrl || !app.config.model) {
        throw new ConfigInputError('请先保存有效的模型配置');
      }
      const id = String(body.id ?? '');
      const task = automations.get(id);
      if (!task) { json(res, 404, { error: '没有这个自动化任务' }); return; }
      if (automations.isRunning(id)) { json(res, 409, { error: '该任务正在运行' }); return; }
      if (task.status === 'completed') { json(res, 409, { error: '任务已完成，无需继续' }); return; }
      runAutomation(id, true);
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && path === '/memory') {
      const file = nodePath.join(app.config.tcodeDir, 'memory.md');
      json(res, 200, { content: existsSync(file) ? readFileSync(file, 'utf8') : '' });
      return;
    }
    if (req.method === 'POST' && path === '/memory') {
      if (busy) { json(res, 409, { error: '任务运行期间不能修改长期记忆' }); return; }
      if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > 256 * 1024) {
        throw new ConfigInputError('记忆内容须为不超过 256KB 的文本');
      }
      const file = nodePath.join(app.config.tcodeDir, 'memory.md');
      if (!body.content) { try { unlinkSync(file); } catch {} }
      else {
        const temporary = file + `.${randomBytes(8).toString('hex')}.tmp`;
        writeFileSync(temporary, body.content, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
      }
      refreshSystemPrompt();
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && path === '/memory/clear') {
      if (busy) { json(res, 409, { error: '任务运行期间不能清空长期记忆' }); return; }
      try { unlinkSync(nodePath.join(app.config.tcodeDir, 'memory.md')); } catch {}
      refreshSystemPrompt();
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && path === '/usage/balance') {
      if (busy) { json(res, 409, { error: '任务运行期间不能查询账户余额' }); return; }
      if (!app.config.apiKey || !app.config.baseUrl || !app.config.model) {
        throw new ConfigInputError('请先保存有效的模型配置');
      }
      if (app.config.protocol === 'anthropic' || app.registry.providers().find((entry) => entry.matches(app.config.baseUrl))?.name === 'anthropic') {
        throw new ConfigInputError('当前端点为 Anthropic 协议，服务商未提供余额查询接口');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const balance = await fetchBalance(app.config.baseUrl, app.config.apiKey, controller.signal);
        json(res, 200, { balance, checkedAt: new Date().toISOString() });
      } catch (error) {
        if (controller.signal.aborted) { json(res, 504, { error: '查询账户余额超时（10 秒）' }); return; }
        // 先遮蔽凭证再截断；半截密钥不能出现在错误里
        json(res, 502, { error: safeError((error as Error).message).slice(0, 400) });
      } finally {
        clearTimeout(timer);
      }
      return;
    }
    if (req.method === 'POST' && path === '/model/test') {
      if (busy) { json(res, 409, { error: '任务运行期间不能测试模型连接' }); return; }
      if (!app.config.apiKey || !app.config.baseUrl || !app.config.model) {
        // 钥匙串读取失败等配置级错误优先透出，指引重填密钥
        throw new ConfigInputError(app.config.configError?.includes('钥匙串') ? app.config.configError : '请先保存有效的模型配置');
      }
      const previousStatus = status, controller = new AbortController();
      const probeUsage = { prompt_tokens: 0, completion_tokens: 0 };
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
      busy = true; status = 'running'; abort = controller; sendState();
      const started = Date.now();
      try {
        // 固定探测不带项目内容或工具；测试用量单独返回，不计入会话。
        const result = await app.provider.chat([{ role: 'user', content: 'Reply with OK.' }], {
          signal: controller.signal,
          onUsage: (value) => { probeUsage.prompt_tokens += value.prompt_tokens; probeUsage.completion_tokens += value.completion_tokens; },
        });
        controller.signal.throwIfAborted();
        if (!result.message.content?.trim()) throw new Error('模型未返回文本，请检查模型与协议');
        json(res, 200, { ok: true, elapsedMs: Date.now() - started, usage: probeUsage });
      } catch (error) {
        json(res, controller.signal.aborted ? (timedOut ? 408 : 499) : 502, {
          error: controller.signal.aborted ? (timedOut ? '连接测试超时（10 秒）' : '已取消连接测试') : safeError((error as Error).message),
        });
      } finally {
        clearTimeout(timer); busy = false; status = previousStatus; abort = null; sendState();
      }
      return;
    }
    if (req.method === 'POST' && path === '/model-profiles/select') {
      if (busy) { json(res, 409, { error: '任务运行期间不能切换模型配置' }); return; }
      let provider = app.provider;
      const next = selectModelProfile(app.config, body.id, (candidate) => { provider = modelProvider(candidate); });
      Object.assign(app.config, next); app.provider = provider;
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'POST' && path === '/model-profiles/delete') {
      if (busy) { json(res, 409, { error: '任务运行期间不能删除模型配置' }); return; }
      Object.assign(app.config, deleteModelProfile(app.config, body.id));
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'POST' && path === '/model-profiles/save') {
      if (busy) { json(res, 409, { error: '任务运行期间不能修改模型配置' }); return; }
      let provider = app.provider;
      const next = saveModelProfile(app.config, body, (candidate) => { provider = modelProvider(candidate); });
      Object.assign(app.config, next); app.provider = provider;
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'GET' && path === '/model-profiles/export') {
      // 结构上不含密钥：只有 hasApiKey 标记，导出文件可安全分享
      json(res, 200, { exportedAt: new Date().toISOString(),
        profiles: (app.config.modelProfiles ?? []).map((profile) => ({
          name: profile.name, baseUrl: profile.baseUrl, model: profile.model,
          protocol: profile.protocol ?? 'auto', contextLimit: profile.contextLimit, hasApiKey: !!(profile.apiKey || profile.keyRef),
        })) });
      return;
    }
    if (req.method === 'POST' && path === '/model-profiles/import') {
      if (busy) { json(res, 409, { error: '任务运行期间不能导入模型配置' }); return; }
      const report = importModelProfiles(app.config, body.profiles);
      Object.assign(app.config, report.config);
      json(res, 200, { ok: true, imported: report.imported, skipped: report.skipped, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'POST' && path === '/config') {
      if (busy) { json(res, 409, { error: '任务运行期间不能修改配置' }); return; }
      let provider = app.provider;
      const next = saveWebConfig(app.config, body, (candidate) => { provider = modelProvider(candidate); });
      switchWorkspace(next); app.provider = provider;
      if (body.approval !== undefined) app.yolo.value = next.approval === 'never';
      json(res, 200, { ok: true, state: snapshot() });
      sendState(); return;
    }
    if (req.method === 'POST' && path === '/yolo') {
      if (busy) { json(res, 409, { error: '任务运行期间不能修改权限' }); return; }
      if (typeof body.value !== 'boolean') { json(res, 400, { error: '权限值须为布尔值' }); return; }
      app.yolo.value = body.value;
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }
    if (req.method === 'POST' && path.startsWith('/session/')) {
      if (busy) { json(res, 409, { error: '任务运行期间不能切换或修改会话' }); return; }
      if (!snapshot().ready) { json(res, 409, { error: '请先配置模型与项目' }); return; }
      if (path === '/session/new') { resetModes(); app.resetMessages(); app.startSession(); replaceActivity([]); }
      else if (path === '/session/select') {
        if (typeof body.id !== 'string' || !body.id || (body.workspace !== undefined && (typeof body.workspace !== 'string' || !nodePath.isAbsolute(body.workspace)))) {
          throw new ConfigInputError('请选择有效的会话标识与绝对项目目录');
        }
        let workspace: string;
        try {
          workspace = realpathSync(body.workspace === undefined ? app.config.workspace ?? process.cwd() : body.workspace as string);
          if (!statSync(workspace).isDirectory()) throw new Error();
          store.history(body.id, workspace);
        } catch { throw new ConfigInputError('项目不可用或该项目中没有这个会话'); }
        if (workspace === app.config.workspace) activate(body.id, workspace);
        else {
          const previousDirectory = process.cwd();
          activate(body.id, workspace, () => {
            try { process.chdir(workspace); Object.assign(app.config, saveWorkspace(app.config, workspace)); }
            catch (error) { process.chdir(previousDirectory); throw error; }
          });
        }
      }
      else if (path === '/session/rename') store.rename(String(body.id ?? ''), process.cwd(), String(body.title ?? ''));
      else { json(res, 404, { error: '未知会话操作' }); return; }
      json(res, 200, { ok: true, state: snapshot() }); sendState(); return;
    }

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
        `data: ${JSON.stringify({ type: 'hello', model: app.config.model, yolo: app.yolo.value, version: VERSION, state: snapshot() })}\n\n`
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
      if (automations.anyRunning()) {
        json(res, 409, { error: '自动化任务正在运行（与主会话共用工作目录基准），请等待完成或先停止任务' });
        return;
      }
      if (!snapshot().ready) { json(res, 409, { error: '请先在模型设置中完成模型与项目配置' }); return; }
      const text = String(body.text ?? '').trim();
      if (!text) {
        json(res, 400, { error: '空输入' });
        return;
      }
      json(res, 200, { ok: true });
      // turn 已通过 SSE 发出错误终态；异步任务必须接收拒绝，不能连带退出服务。
      void runTurnAsync(text).catch(() => {});
      return;
    }
    if (req.method === 'POST' && path === '/permission') {
      const id = String(body.id ?? '');
      const decision = body.decision;
      const resolve = pending.get(id);
      if (!resolve || (decision !== 'allow' && decision !== 'deny' && decision !== 'always')) {
        json(res, 404, { error: '没有这个待确认请求' });
        return;
      }
      pending.delete(id);
      resolve(decision);
      status = 'running';
      json(res, 200, { ok: true });
      sendState();
      return;
    }
    if (req.method === 'POST' && path === '/abort') {
      abort?.abort();
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/command') {
      if (busy) { json(res, 409, { error: '任务运行期间不能执行会话命令' }); return; }
      const line = String(body.line ?? '').trim();
      const [rawCmd, ...args] = line.replace(/^\//, '').split(/\s+/);
      if (rawCmd === 'resume' || rawCmd === 'sessions') {
        const output = '请使用左侧当前项目的会话列表查看和恢复历史';
        sendEvent({ type: 'command', output });
        json(res, 200, { output, state: snapshot() }); return;
      }
      const cmd = app.registry.commands().find((c) => c.name === rawCmd);
      if (!cmd) {
        json(res, 404, { error: `未知命令 /${rawCmd}，/help 查看可用命令` });
        return;
      }
      captureBuf = [];
      busy = true;
      abort = new AbortController();
      sendState();
      try {
        if (rawCmd === 'new') resetModes();
        const outcome = await cmd.run(app, args, {
          signal: abort.signal,
          onUsage: (usage) => bridgeEvent({ type: 'usage', ...usage }),
        });
        const output = safeError((captureBuf ?? []).join('\n').replace(ANSI_RE, ''));
        if (rawCmd === 'new') replaceActivity([]);
        refreshSystemPrompt(); // /memory 等命令可能改系统提示词来源文件
        sendEvent({ type: 'command', output });
        busy = false;
        json(res, 200, {
          output,
          exit: outcome?.exit === true,
          reset: rawCmd === 'new' || rawCmd === 'resume',
          yolo: app.yolo.value,
          state: snapshot(),
        });
        if (outcome?.exit) setTimeout(() => process.exit(0), 200);
      } finally {
        captureBuf = null;
        busy = false;
        abort = null;
        sendState();
      }
      return;
    }
    res.writeHead(404).end('not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: Error) => {
      if (!res.headersSent) res.writeHead(e instanceof ConfigInputError ? 400 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: safeError(e.message) }));
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/t/${token}/`;
  console.log(`tcode web v${VERSION} · ${app.config.model} · ${process.cwd()}`);
  console.log(url);
  console.log('浏览器打开上面地址即可使用；Ctrl+C 退出服务');
  // 心跳防中间层断连；unref 不阻止进程退出
  const ping = setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n');
  }, 25_000);
  ping.unref();
  // 周期任务调度推进；到期时后台执行并广播状态
  const scheduler = setInterval(() => {
    void automations.tick(app).then(() => {
      const line = `data: ${JSON.stringify({ type: 'automation', seq: ++seq })}\n\n`;
      for (const res of sseClients) res.write(line);
    }).catch(() => {});
  }, 30_000);
  scheduler.unref();
}

export default definePlugin({ name: 'web', kind: 'shell', start: startWeb });
