// 配置加载：环境变量 > ~/.gcode/config.json > 报错指路。
// 刻意不写死任何默认端点/模型——本地优先工具，用户自己决定请求发去哪。
// 协议选择不走这里：protocol 只有显式配置时才非空，自动识别由 provider 插件的 matches 做。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Protocol } from './types.ts';

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 仅显式配置（GCODE_PROTOCOL / config.json）时非空；否则由 provider 插件按 URL 自动识别 */
  protocol?: Protocol;
  /** 估算 token 上限，超过即触发上下文裁剪 */
  contextLimit: number;
  /** ~/.gcode 目录，配置/会话/全局指令都住这里 */
  gcodeDir: string;
}

interface FileConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  protocol?: string;
}

function readJsonConfig(gcodeDir: string): FileConfig {
  const file = path.join(gcodeDir, 'config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as FileConfig;
  } catch (e) {
    throw new Error(`~/.gcode/config.json 解析失败：${(e as Error).message}`);
  }
}

export function loadConfig(): Config {
  const gcodeDir = path.join(homedir(), '.gcode');
  const file = readJsonConfig(gcodeDir);
  const apiKey = process.env.GCODE_API_KEY ?? file.apiKey ?? '';
  const baseUrl = (process.env.GCODE_BASE_URL ?? file.baseUrl ?? '').replace(/\/+$/, '');
  const model = process.env.GCODE_MODEL ?? file.model ?? '';
  const contextLimit = Number(process.env.GCODE_CONTEXT_LIMIT) || 100_000;

  const rawProtocol = (process.env.GCODE_PROTOCOL ?? file.protocol ?? '').toLowerCase();
  let protocol: Protocol | undefined;
  if (rawProtocol) {
    if (rawProtocol !== 'openai' && rawProtocol !== 'anthropic') {
      throw new Error(`GCODE_PROTOCOL 只能是 openai 或 anthropic，收到：${rawProtocol}`);
    }
    protocol = rawProtocol;
  }

  const missing = [
    ['GCODE_API_KEY', apiKey] as const,
    ['GCODE_BASE_URL', baseUrl] as const,
    ['GCODE_MODEL', model] as const,
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `缺少模型配置：${missing.join('、')}。\n` +
        `设置方式（二选一）：\n` +
        `  1. 环境变量：export GCODE_API_KEY=sk-xxx GCODE_BASE_URL=https://xxx/v1 GCODE_MODEL=模型名\n` +
        `  2. 配置文件：~/.gcode/config.json 写 {"apiKey":"...","baseUrl":"...","model":"..."}\n` +
        `任何 OpenAI 兼容端点都可以（本地中转、云 API 均可）。`
    );
  }
  return { apiKey, baseUrl, model, protocol, contextLimit, gcodeDir };
}
