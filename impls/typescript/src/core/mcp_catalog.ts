// MCP 服务器内置目录：无需网络的静态精选清单，供"从目录添加"预填表单。
// 条目为公开的官方参考实现；args 中的占位参数（如目录路径）由用户保存前修改。
export interface McpCatalogEntry {
  name: string;
  description: string;
  command: string;
  /** HTTP Streamable 传输端点；存在时 command 为空也可（与服务器配置同语义） */
  url?: string;
  args?: string[];
  env?: Record<string, string>;
}

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    name: 'filesystem',
    description: '文件系统访问（官方参考实现）：把指定目录暴露为可读写资源与工具',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '<目录路径>'],
  },
  {
    name: 'memory',
    description: '基于本地知识图谱的持久记忆（官方参考实现）',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    name: 'everything',
    description: 'MCP 全能力测试服务器（官方参考实现），适合验证桥接是否工作',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
  },
  {
    name: 'fetch',
    description: '网页抓取（官方参考实现）：把网页内容转换为 Markdown',
    command: 'uvx',
    args: ['mcp-server-fetch'],
  },
];

/**
 * 读取用户扩展目录 <数据目录>/mcp-catalog.json（数组，条目同内置形状）。
 * 同名（name）条目覆盖内置；文件缺失返回空；格式非法时通过 catalogError 报告并回退内置。
 */
export function loadUserCatalog(tcodeDir: string): { entries: McpCatalogEntry[]; catalogError?: string } {
  const file = path.join(tcodeDir, 'mcp-catalog.json');
  if (!existsSync(file)) return { entries: [] };
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(value)) throw new Error();
    const entries: McpCatalogEntry[] = [];
    for (const raw of value) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!name || !/^[a-zA-Z0-9_-]{1,40}$/.test(name)) throw new Error();
      const command = typeof entry.command === 'string' ? entry.command.trim() : '';
      let url: string | undefined;
      if (entry.url !== undefined) {
        if (typeof entry.url !== 'string') throw new Error();
        url = entry.url;
        try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch { throw new Error(); }
      }
      if (!command && !url) throw new Error();
      const description = typeof entry.description === 'string' ? entry.description : '';
      let args: string[] | undefined;
      if (entry.args !== undefined) {
        if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string')) throw new Error();
        args = entry.args as string[];
      }
      const env: Record<string, string> | undefined = entry.env === undefined ? undefined : (() => {
        if (typeof entry.env !== 'object' || entry.env === null || Object.values(entry.env).some((v) => typeof v !== 'string')) throw new Error();
        return entry.env as Record<string, string>;
      })();
      const normalized: McpCatalogEntry = { name, description: description || '（无描述）', command, ...(url ? { url } : {}), ...(args ? { args } : {}), ...(env ? { env } : {}) };
      entries.push(normalized);
    }
    return { entries };
  } catch (error) {
    return { entries: [], catalogError: `mcp-catalog.json 格式无效（${(error as Error).message || '解析失败'}），已回退内置目录` };
  }
}

/** 合并目录：内置为基底，用户同名覆盖、其余追加（用户条目在后） */
export function mergedCatalog(tcodeDir: string): { catalog: McpCatalogEntry[]; userCount: number; catalogError?: string } {
  const { entries, catalogError } = loadUserCatalog(tcodeDir);
  const merged = new Map(MCP_CATALOG.map((entry) => [entry.name, entry]));
  for (const entry of entries) merged.set(entry.name, entry);
  return { catalog: [...merged.values()], userCount: entries.length, catalogError };
}
