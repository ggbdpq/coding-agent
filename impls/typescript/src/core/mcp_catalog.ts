// MCP 服务器内置目录：无需网络的静态精选清单，供"从目录添加"预填表单。
// 条目为公开的官方参考实现；args 中的占位参数（如目录路径）由用户保存前修改。
export interface McpCatalogEntry {
  name: string;
  description: string;
  command: string;
  args: string[];
}

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
