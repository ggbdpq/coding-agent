// MCP stdio 客户端：外部工具服务器以子进程运行，JSON-RPC 2.0 over 换行分隔 stdio。
// 按需连接（initialize → tools/list），连接长驻复用；配置停用/删除时回收进程。
// 工具以 mcp__<server>__<tool> 桥接进工具列表，调用走主审批闸（needsPermission）。
import { spawn, type ChildProcess } from 'node:child_process';
import { sseData } from '../providers/sse.ts';

let nextHttpRequestId = 1;
import type { ToolPlugin } from '../kernel/plugin.ts';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  /** HTTP Streamable 传输端点；存在时走 HTTP，否则走 stdio */
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  /** 信任此服务器：工具免逐次审批 */
  trusted?: boolean;
  /** 按工具粒度免审批白名单；trusted 整服务器优先 */
  trustedTools?: string[];
}

interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown>; }

interface Connection {
  child?: ChildProcess;
  tools: McpTool[];
  request: (method: string, params: Record<string, unknown>, timeout: number) => Promise<Record<string, unknown>>;
  shutdown: () => void;
}

const REQUEST_TIMEOUT = 10_000;
const CALL_TIMEOUT = 60_000;

export class McpManager {
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly toolsCache = new Map<string, McpTool[]>();
  private readonly resourcesCache = new Map<string, Array<{ uri: string; name: string; description?: string }>>();
  private readonly promptsCache = new Map<string, Array<{ name: string; description?: string; arguments?: Array<{ name: string }> }>>();

  /** 已启用服务器的工具桥接列表；停用的服务器回收进程 */
  toolPlugins(servers: McpServerConfig[], cwd: string): ToolPlugin[] {
    const plugins: ToolPlugin[] = [];
    for (const server of servers) {
      if (!server.enabled) { this.shutdown(server.id); continue; }
      for (const tool of this.toolsCache.get(server.id) ?? []) {
        plugins.push(this.wrap(server, tool, cwd));
      }
      // 资源与提示词聚合工具：description 内嵌清单，模型自主选择 uri/name
      if ((this.resourcesCache.get(server.id) ?? []).length) {
        plugins.push({
          name: `mcp__${server.name}__read_resource`,
          kind: 'tool',
          description: `读取 MCP 服务器 ${server.name} 的资源正文。可用资源：\n${this.describeResources(server.id)}`,
          parameters: { type: 'object', properties: { uri: { type: 'string', description: '要读取的资源 URI' } }, required: ['uri'] },
          needsPermission: true,
          skipPermission: server.trusted ? () => true : undefined,
          preview: (args) => `读取 MCP 资源 ${String(args?.uri ?? '')}（服务器 ${server.name}）`,
          run: async (args) => this.readResource(server, cwd, String(args?.uri ?? '')),
        });
      }
      if ((this.promptsCache.get(server.id) ?? []).length) {
        plugins.push({
          name: `mcp__${server.name}__get_prompt`,
          kind: 'tool',
          description: `获取 MCP 服务器 ${server.name} 的提示词模板生成文本。可用提示词：\n${this.describePrompts(server.id)}`,
          parameters: { type: 'object', properties: { name: { type: 'string', description: '提示词名称' }, arguments: { type: 'object', description: '模板参数' } }, required: ['name'] },
          needsPermission: true,
          skipPermission: server.trusted ? () => true : undefined,
          preview: (args) => `获取 MCP 提示词 ${String(args?.name ?? '')}（服务器 ${server.name}）`,
          run: async (args) => this.getPrompt(server, cwd, String(args?.name ?? ''), args?.arguments as Record<string, unknown> | undefined),
        });
      }
    }
    return plugins;
  }

  /** 连接测试：返回工具/资源/提示词清单 */
  async test(server: McpServerConfig, cwd: string): Promise<{ tools: string[]; resources: number; prompts: number }> {
    const connection = await this.ensureConnected(server, cwd);
    return {
      tools: connection.tools.map((tool) => tool.name),
      resources: (this.resourcesCache.get(server.id) ?? []).length,
      prompts: (this.promptsCache.get(server.id) ?? []).length,
    };
  }

  /** 配置删除/停用时回收子进程与缓存 */
  shutdown(serverId: string): void {
    const pending = this.connections.get(serverId);
    this.connections.delete(serverId);
    this.toolsCache.delete(serverId);
    this.resourcesCache.delete(serverId);
    this.promptsCache.delete(serverId);
    if (pending) void pending.then((connection) => connection.shutdown()).catch(() => {});
  }

  private ensureConnected(server: McpServerConfig, cwd: string): Promise<Connection> {
    const existing = this.connections.get(server.id);
    if (existing) return existing;
    const connecting = server.url ? this.connectHttp(server) : this.connect(server, cwd);
    this.connections.set(server.id, connecting);
    connecting.catch(() => {
      this.connections.delete(server.id);
      this.toolsCache.delete(server.id);
      this.resourcesCache.delete(server.id);
      this.promptsCache.delete(server.id);
    });
    return connecting;
  }

  private async connect(server: McpServerConfig, cwd: string): Promise<Connection> {
    const child = spawn(server.command, server.args ?? [], {
      cwd,
      env: { ...process.env, ...server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-500); });

    const waiters = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    const connection: Connection = {
      child,
      tools: [],
      request: (method, params, timeout) => new Promise((resolve, reject) => {
        const id = nextRequestId++;
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`MCP 请求超时（${Math.round(timeout / 1000)} 秒）：${method}`));
        }, timeout);
        waiters.set(id, { resolve, reject, timer });
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
          if (error) { clearTimeout(timer); waiters.delete(id); reject(new Error(`MCP 服务器输入不可写：${error.message}`)); }
        });
      }),
      shutdown: () => { try { child.kill(); } catch {} },
    };
    let nextRequestId = 1;

    const failAll = (message: string) => {
      for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(message)); }
      waiters.clear();
      this.connections.delete(server.id);
      this.toolsCache.delete(server.id);
    };
    child.on('exit', (code) => failAll(`MCP 服务器进程退出（code ${code ?? 'null'}）${stderrTail ? '：' + stderrTail.trim() : ''}`));
    child.on('error', (error) => failAll(`MCP 服务器无法启动：${error.message}`));

    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === undefined) continue;
        const waiter = waiters.get(Number(message.id));
        if (!waiter) continue;
        waiters.delete(Number(message.id));
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message || 'MCP 请求被服务器拒绝'));
        else waiter.resolve(message.result ?? {});
      }
    });

    try {
      const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`MCP 服务器连接超时${stderrTail ? '：' + stderrTail.trim() : ''}`)), REQUEST_TIMEOUT));
      await Promise.race([
        connection.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tcode', version: '0.5.0' } }, REQUEST_TIMEOUT).then(() => {
          child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
        }),
        deadline,
      ]);
      const listed = (await Promise.race([connection.request('tools/list', {}, REQUEST_TIMEOUT), deadline])) as { tools?: McpTool[] };
      connection.tools = Array.isArray(listed.tools) ? listed.tools : [];
      this.toolsCache.set(server.id, connection.tools);
      await this.loadCapabilities(server.id, connection);
    } catch (error) {
      connection.shutdown();
      failAll((error as Error).message);
      throw error;
    }
    return connection;
  }

  /** HTTP Streamable 传输：无状态 POST（接受 JSON 或 SSE 响应），透传 Mcp-Session-Id */
  private async connectHttp(server: McpServerConfig): Promise<Connection> {
    const url = server.url!;
    let sessionId: string | null = null;
    const request = (method: string, params: Record<string, unknown>, timeout: number): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = nextHttpRequestId++;
        const timer = setTimeout(() => reject(new Error(`MCP 请求超时（${Math.round(timeout / 1000)} 秒）：${method}`)), timeout);
        void (async () => {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
            },
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
            signal: AbortSignal.timeout(timeout),
          });
          const sid = res.headers.get('mcp-session-id');
          if (sid) sessionId = sid;
          if (res.status !== 200) {
            const text = await res.text().catch(() => '');
            reject(new Error(`HTTP ${res.status}：${text.slice(0, 300) || res.statusText}`));
            return;
          }
          const contentType = res.headers.get('content-type') ?? '';
          if (contentType.includes('text/event-stream') && res.body) {
            for await (const data of sseData(res.body)) {
              if (data === '[DONE]') break;
              let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
              try { message = JSON.parse(data); } catch { continue; }
              if (message.id !== id) continue;
              if (message.error) reject(new Error(message.error.message || 'MCP 请求被服务器拒绝'));
              else resolve(message.result ?? {});
              return;
            }
            resolve({});
            return;
          }
          const message = await res.json() as { error?: { message?: string }; result?: Record<string, unknown> };
          if (message.error) reject(new Error(message.error.message || 'MCP 请求被服务器拒绝'));
          else resolve(message.result ?? {});
        })().catch((error: Error) => {
          clearTimeout(timer);
          if (error.name === 'TimeoutError') reject(new Error(`MCP 请求超时（${Math.round(timeout / 1000)} 秒）：${method}`));
          else reject(error);
        });
      });
    const connection: Connection = {
      tools: [],
      request,
      shutdown: () => { if (sessionId) void fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }).catch(() => {}); },
    };
    try {
      const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MCP 服务器连接超时')), REQUEST_TIMEOUT));
      await Promise.race([
        connection.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tcode', version: '0.5.0' } }, REQUEST_TIMEOUT).then(() => {
          void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) }).catch(() => {});
        }),
        deadline,
      ]);
      const listed = (await Promise.race([connection.request('tools/list', {}, REQUEST_TIMEOUT), deadline])) as { tools?: McpTool[] };
      connection.tools = Array.isArray(listed.tools) ? listed.tools : [];
      this.toolsCache.set(server.id, connection.tools);
      await this.loadCapabilities(server.id, connection);
    } catch (error) {
      connection.shutdown();
      this.connections.delete(server.id);
      this.toolsCache.delete(server.id);
      throw error;
    }
    return connection;
  }

  /** 连接后拉取资源与提示词清单（失败不阻塞工具桥接，仅缺失该能力） */
  private async loadCapabilities(serverId: string, connection: Connection): Promise<void> {
    try {
      const listed = await connection.request('resources/list', {}, REQUEST_TIMEOUT) as { resources?: Array<{ uri: string; name: string; description?: string }> };
      this.resourcesCache.set(serverId, Array.isArray(listed.resources) ? listed.resources : []);
    } catch { this.resourcesCache.delete(serverId); }
    try {
      const listed = await connection.request('prompts/list', {}, REQUEST_TIMEOUT) as { prompts?: Array<{ name: string; description?: string; arguments?: Array<{ name: string }> }> };
      this.promptsCache.set(serverId, Array.isArray(listed.prompts) ? listed.prompts : []);
    } catch { this.promptsCache.delete(serverId); }
  }

  /** 系统提示词注入段：启用且已连接服务器的资源/提示词清单；无内容返回空串 */
  promptSection(servers: McpServerConfig[]): string {
    const blocks: string[] = [];
    for (const server of servers) {
      if (!server.enabled) continue;
      const resources = this.resourcesCache.get(server.id) ?? [];
      const prompts = this.promptsCache.get(server.id) ?? [];
      if (!resources.length && !prompts.length) continue;
      const lines = [`MCP 服务器 ${server.name}：`];
      for (const resource of resources) lines.push(`- 资源 ${resource.uri} — ${resource.name}`);
      for (const prompt of prompts) lines.push(`- 提示词 ${prompt.name} — ${prompt.description ?? ''}（用 ${server.name} 的 get_prompt 工具获取）`);
      blocks.push(lines.join('\n'));
    }
    return blocks.length ? '\n\n# 可用的 MCP 资源与提示词\n' + blocks.join('\n\n') : '';
  }

  private describeResources(serverId: string): string {
    const resources = this.resourcesCache.get(serverId) ?? [];
    return resources.map((resource) => `${resource.uri} — ${resource.name}`).join('\n') || '（服务器未提供资源）';
  }

  private describePrompts(serverId: string): string {
    const prompts = this.promptsCache.get(serverId) ?? [];
    return prompts.map((prompt) => `${prompt.name} — ${prompt.description ?? ''}`).join('\n') || '（服务器未提供提示词）';
  }

  /** 读取资源正文（resources/read） */
  private async readResource(server: McpServerConfig, cwd: string, uri: string): Promise<string> {
    const connection = await this.ensureConnected(server, cwd);
    const result = await connection.request('resources/read', { uri }, CALL_TIMEOUT);
    const contents = Array.isArray(result.contents) ? result.contents as Array<{ text?: string }> : [];
    const text = contents.map((block) => typeof block?.text === 'string' ? block.text : JSON.stringify(block)).join('\n');
    return text || '（资源无文本内容）';
  }

  /** 获取提示词模板生成的消息文本（prompts/get） */
  private async getPrompt(server: McpServerConfig, cwd: string, name: string, args: Record<string, unknown> | undefined): Promise<string> {
    const connection = await this.ensureConnected(server, cwd);
    const result = await connection.request('prompts/get', { name, arguments: args ?? {} }, CALL_TIMEOUT);
    const messages = Array.isArray(result.messages) ? result.messages as Array<{ content?: { text?: string } }> : [];
    const text = messages.map((message) => typeof message.content?.text === 'string' ? message.content.text : JSON.stringify(message.content)).join('\n');
    return text || '（提示词未生成文本）';
  }

  private async callTool(connection: Connection, toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = await connection.request('tools/call', { name: toolName, arguments: args }, CALL_TIMEOUT);
    const content = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
    const text = content.map((block) => typeof block?.text === 'string' ? block.text : JSON.stringify(block)).join('\n');
    return text || '（MCP 工具无文本输出）';
  }

  private wrap(server: McpServerConfig, tool: McpTool, cwd: string): ToolPlugin {
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' && (tool.inputSchema as { type?: string }).type === 'object'
      ? tool.inputSchema : { type: 'object', properties: {} };
    return {
      name: `mcp__${server.name}__${tool.name}`,
      kind: 'tool',
      description: `${tool.description || `MCP 工具 ${tool.name}`}（来自 MCP 服务器 ${server.name}）`,
      parameters: schema,
      needsPermission: true,
      // 信任的服务器整体免审批，或按工具白名单；复用蓝图 R4 的 skipPermission 机制
      skipPermission: server.trusted || (server.trustedTools ?? []).includes(tool.name) ? () => true : undefined,
      preview: (args) => `MCP ${server.name}.${tool.name}\n${JSON.stringify(args ?? {}).slice(0, 2000)}`,
      run: async (args) => {
        const connection = await this.ensureConnected(server, cwd);
        return this.callTool(connection, tool.name, args ?? {});
      },
    };
  }
}
