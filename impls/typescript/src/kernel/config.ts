// 配置加载：环境变量 > ~/.tcode/config.json > 报错指路。
// 刻意不写死任何默认端点/模型——本地优先工具，用户自己决定请求发去哪。
// 协议选择不走这里：protocol 只有显式配置时才非空，自动识别由 provider 插件的 matches 做。
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Protocol } from './types.ts';
import { deleteSecret, getSecret, keyStoreFor, setSecret } from './keyring.ts';

export interface WebPreferences {
  theme: 'system' | 'dark' | 'light';
  fontSize: 14 | 16 | 18;
  enterToSend: boolean;
}
const defaultPreferences: WebPreferences = { theme: 'system', fontSize: 16, enterToSend: true };

export interface ModelProfile {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  protocol?: Protocol;
  contextLimit: number;
  /** 密钥在钥匙串的引用（account）；存在时 apiKey 为空串，明文不落盘 */
  keyRef?: string;
}

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 仅显式配置（TCODE_PROTOCOL / config.json）时非空；否则由 provider 插件按 URL 自动识别 */
  protocol?: Protocol;
  /**
   * 审批策略（蓝图 R4）：normal=写类逐次确认（默认）；never=全部免确认（--yolo 等价）。
   * Codex 式 untrusted/on-failure 依赖 OS 沙箱，tcode v1 明确不做。
   */
  approval?: 'normal' | 'never';
  /**
   * 写白名单（蓝图 R4）：位于这些目录内的 write/edit 免确认（目录须为绝对路径）。
   * bash/web_fetch 不受白名单影响（命令级操作无法按路径约束），仍逐次确认。
   */
  allowWriteDirs?: string[];
  /** 轮次结束钩子：每轮结束后以用户权限在项目目录执行的 shell 命令 */
  afterTurn?: string;
  /** 轮次开始钩子：每轮开始前以用户权限在项目目录执行的 shell 命令 */
  beforeTurn?: string;
  /** 估算 token 上限，超过即触发上下文裁剪 */
  contextLimit: number;
  /** 工具往返轮次上限（WP5）：超过即熔断强制总结收尾；正整数，缺省 40 */
  maxToolRounds?: number;
  /** ~/.tcode 目录，配置/会话/全局指令都住这里 */
  tcodeDir: string;
  /** Web 的单一工作目录；终端模式仍使用调用目录。 */
  workspace?: string;
  /** 用户打开过的项目；当前项目仍由 workspace 唯一决定。 */
  projects?: string[];
  /** 归档仅隐藏导航，项目文件与历史仍保留。 */
  archivedProjects?: string[];
  preferences?: WebPreferences;
  modelProfiles?: ModelProfile[];
  activeModelProfileId?: string | null;
  /** 外部 MCP 工具服务器（stdio）；enabled 控制是否桥接进工具列表 */
  mcpServers?: McpServerConfig[];
  configError?: string;
}

export interface McpServerConfig {
  id: string;
  /** 工具名标识：^[a-zA-Z0-9_-]{1,40}$，桥接为 mcp__<name>__<tool> */
  name: string;
  /** stdio 传输的启动命令；url 存在时使用 HTTP 传输，此字段可空 */
  command: string;
  /** HTTP Streamable 传输的端点；存在时优先于 command */
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  /** 信任此服务器：其工具免逐次审批直接执行（白名单语义，蓝图 R4） */
  trusted?: boolean;
  /** 按工具粒度免审批白名单（工具名列表）；trusted 整服务器优先 */
  trustedTools?: string[];
}

interface FileConfig {
  apiKey?: string;
  /** 顶层未命名活动配置的钥匙串引用；存在时 apiKey 为空串 */
  keyRef?: string;
  baseUrl?: string;
  model?: string;
  protocol?: string;
  approval?: string;
  allowWriteDirs?: string[];
  afterTurn?: string;
  beforeTurn?: string;
  contextLimit?: number;
  maxToolRounds?: number;
  workspace?: string;
  projects?: string[];
  archivedProjects?: string[];
  preferences?: WebPreferences;
  modelProfiles?: ModelProfile[];
  activeModelProfileId?: string | null;
  mcpServers?: McpServerConfig[];
}

function readJsonConfig(tcodeDir: string): FileConfig {
  const file = path.join(tcodeDir, 'config.json');
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const fields = value as Record<string, unknown>;
    for (const key of ['apiKey', 'baseUrl', 'model', 'protocol', 'approval', 'workspace', 'keyRef', 'afterTurn', 'beforeTurn']) {
      if (fields[key] !== undefined && typeof fields[key] !== 'string') throw new Error();
    }
    if (fields.protocol !== undefined && !['openai', 'anthropic'].includes(String(fields.protocol))) throw new Error();
    if (fields.approval !== undefined && !['normal', 'never'].includes(String(fields.approval))) throw new Error();
    if (fields.contextLimit !== undefined && (!Number.isSafeInteger(fields.contextLimit) || Number(fields.contextLimit) <= 0)) throw new Error();
    if (fields.allowWriteDirs !== undefined && (!Array.isArray(fields.allowWriteDirs) || fields.allowWriteDirs.some((dir) => typeof dir !== 'string'))) throw new Error();
    if (fields.afterTurn !== undefined && typeof fields.afterTurn !== 'string') throw new Error();
    for (const key of ['projects', 'archivedProjects']) {
      const dirs = fields[key];
      if (dirs !== undefined && (!Array.isArray(dirs) || dirs.some((dir) => typeof dir !== 'string' || !path.isAbsolute(dir)))) throw new Error();
    }
    if (fields.preferences !== undefined) validatePreferences(fields.preferences);
    if (fields.modelProfiles !== undefined) {
      if (!Array.isArray(fields.modelProfiles)) throw new Error();
      const ids = new Set<string>();
      for (const profile of fields.modelProfiles as ModelProfile[]) {
        if (!profile || typeof profile.id !== 'string' || !profile.id.trim() || typeof profile.name !== 'string' || !profile.name.trim() || ids.has(profile.id)) throw new Error();
        // apiKey 允许为空：导入的脱敏配置在原端点重新填写密钥前不可用（select 后错误可见）
        if (typeof profile.apiKey !== 'string' || typeof profile.baseUrl !== 'string' || !profile.baseUrl || typeof profile.model !== 'string' || !profile.model || !Number.isSafeInteger(profile.contextLimit) || profile.contextLimit <= 0) throw new Error();
        if (profile.keyRef !== undefined && typeof profile.keyRef !== 'string') throw new Error();
        if (profile.protocol !== undefined && !['openai', 'anthropic'].includes(profile.protocol)) throw new Error();
        let parsedUrl: URL;
        try { parsedUrl = new URL(profile.baseUrl); } catch { throw new Error(); }
        if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error();
        ids.add(profile.id);
      }
    }
    if (fields.activeModelProfileId !== undefined && fields.activeModelProfileId !== null && (typeof fields.activeModelProfileId !== 'string' || !(fields.modelProfiles as ModelProfile[] | undefined)?.some((profile) => profile.id === fields.activeModelProfileId))) throw new Error();
    if (fields.mcpServers !== undefined) {
      if (!Array.isArray(fields.mcpServers)) throw new Error();
      const ids = new Set<string>();
      for (const server of fields.mcpServers as McpServerConfig[]) {
        if (!server || typeof server.id !== 'string' || !server.id || typeof server.name !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(server.name) || ids.has(server.id)) throw new Error();
        // command 与 url 至少其一：url 为 HTTP 传输，command 为 stdio
        if (server.command !== undefined && typeof server.command !== 'string') throw new Error();
        let hasUrl = false;
        if (server.url !== undefined) {
          if (typeof server.url !== 'string') throw new Error();
          try { const parsed = new URL(server.url); hasUrl = ['http:', 'https:'].includes(parsed.protocol); } catch { hasUrl = false; }
          if (!hasUrl) throw new Error();
        }
        if (!server.command && !hasUrl) throw new Error();
        if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))) throw new Error();
        if (server.env !== undefined && (typeof server.env !== 'object' || server.env === null || Object.values(server.env).some((value) => typeof value !== 'string'))) throw new Error();
        if (server.trusted !== undefined && server.trusted !== true && server.trusted !== false) throw new Error();
        if (server.trustedTools !== undefined && (!Array.isArray(server.trustedTools) || server.trustedTools.some((tool) => typeof tool !== 'string' || !tool))) throw new Error();
        ids.add(server.id);
      }
    }
    return value as FileConfig;
  } catch {
    throw new Error('config.json 的格式或字段无效，请在模型设置中重新保存');
  }
}

export function resolveTcodeDir(): string {
  return path.resolve(process.env.TCODE_DATA_DIR || path.join(homedir(), '.tcode'));
}

export function loadConfig(options: { allowIncomplete?: boolean; desktop?: boolean } = {}): Config {
  const tcodeDir = resolveTcodeDir();
  let file: FileConfig = {};
  let configError: string | undefined;
  try { file = readJsonConfig(tcodeDir); }
  catch (error) {
    if (!options.allowIncomplete) throw error;
    configError = (error as Error).message;
  }
  const store = keyStoreFor(tcodeDir);
  const fromEnv = process.env.TCODE_API_KEY !== undefined && process.env.TCODE_API_KEY !== '';
  let apiKey: string;
  if (fromEnv) apiKey = process.env.TCODE_API_KEY!;
  else if (file.keyRef) {
    const secret = store.available ? getSecret(store, file.keyRef) : null;
    if (secret === null) {
      apiKey = '';
      configError = '从钥匙串读取活动密钥失败，请在模型设置重新保存密钥';
    } else apiKey = secret;
  } else apiKey = file.apiKey ?? '';
  const baseUrl = (process.env.TCODE_BASE_URL ?? file.baseUrl ?? '').replace(/\/+$/, '');
  const model = process.env.TCODE_MODEL ?? file.model ?? '';
  const contextLimit = Number(process.env.TCODE_CONTEXT_LIMIT || file.contextLimit) || 100_000;

  // WP5：工具往返轮次上限——必须正整数，非法值报错且信息含字段名，不静默回退默认
  //（readJsonConfig 的 catch 会吞字段名，故校验在此做；allowIncomplete 时进 configError 可见）。
  // TCODE_MAX_TOOL_ROUNDS：环境变量入口（conformance 场景级配置 max_tool_rounds 的映射通道，
  // 与 TCODE_CONTEXT_LIMIT 同模式；env 是字符串，非法同样报错不静默）
  let maxToolRounds = 40;
  const maxToolRoundsRaw: unknown = process.env.TCODE_MAX_TOOL_ROUNDS ?? file.maxToolRounds;
  if (maxToolRoundsRaw !== undefined && maxToolRoundsRaw !== '') {
    const raw = typeof maxToolRoundsRaw === 'number' ? maxToolRoundsRaw : Number(maxToolRoundsRaw);
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      if (!options.allowIncomplete) throw new Error('maxToolRounds 必须是正整数');
      configError = 'maxToolRounds 无效，必须是正整数，已回退默认 40';
    } else maxToolRounds = raw;
  }

  const rawProtocol = (process.env.TCODE_PROTOCOL ?? file.protocol ?? '').toLowerCase();
  let protocol: Protocol | undefined;
  if (rawProtocol) {
    if (rawProtocol !== 'openai' && rawProtocol !== 'anthropic') {
      if (!options.allowIncomplete) throw new Error('TCODE_PROTOCOL 只能是 openai 或 anthropic');
      configError = 'TCODE_PROTOCOL 无效，请修正环境变量后重启';
    } else protocol = rawProtocol;
  }

  // 审批策略：环境变量 --approval > config.json；yolo/never 等价（默认 normal 逐次确认）
  const rawApproval = (process.env.TCODE_APPROVAL ?? file.approval ?? '').toLowerCase();
  let approval: 'normal' | 'never' | undefined;
  if (rawApproval) {
    if (rawApproval !== 'normal' && rawApproval !== 'never') {
      if (!options.allowIncomplete) throw new Error('TCODE_APPROVAL 只能是 normal 或 never');
      configError = 'TCODE_APPROVAL 无效，请修正环境变量后重启';
    } else approval = rawApproval;
  }

  // 写白名单：config.json allowWriteDirs 或环境变量 TCODE_ALLOW_WRITE（pathsep 分隔）
  const allowWriteDirs = (
    file.allowWriteDirs ??
    (process.env.TCODE_ALLOW_WRITE ? process.env.TCODE_ALLOW_WRITE.split(path.delimiter) : [])
  )
    .map((d) => path.resolve(d))
    .filter((d) => d.length > 0);

  const missing = [
    ['TCODE_API_KEY', apiKey] as const,
    ['TCODE_BASE_URL', baseUrl] as const,
    ['TCODE_MODEL', model] as const,
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0 && !options.allowIncomplete) {
    throw new Error(
      `缺少模型配置：${missing.join('、')}。\n` +
        `设置方式（二选一）：\n` +
        `  1. 环境变量：export TCODE_API_KEY=sk-xxx TCODE_BASE_URL=https://xxx/v1 TCODE_MODEL=模型名\n` +
        `  2. 配置文件：~/.tcode/config.json 写 {"apiKey":"...","baseUrl":"...","model":"..."}\n` +
        `任何 OpenAI 兼容端点都可以（本地中转、云 API 均可）。`
    );
  }
  const selected = file.modelProfiles?.find((profile) => profile.id === file.activeModelProfileId);
  // env 覆盖时活动值来自环境，不与任何保存项匹配；keyRef 型 profile 比较顶层引用
  // 匹配语义：非 env 时 keyRef 型比较顶层引用、明文型比较明文；env 覆盖值与保存密钥等价时仍算激活
  const keyMatches = selected ? (selected.keyRef
    ? (fromEnv ? process.env.TCODE_API_KEY === getSecret(store, selected.keyRef) : selected.keyRef === (file.keyRef ?? null))
    : apiKey === selected.apiKey) : false;
  const activeModelProfileId = selected && keyMatches && selected.baseUrl === baseUrl && selected.model === model
    && selected.protocol === protocol && selected.contextLimit === contextLimit ? selected.id : null;
  return { apiKey, baseUrl, model, protocol, approval, allowWriteDirs, afterTurn: file.afterTurn, beforeTurn: file.beforeTurn, contextLimit, maxToolRounds, tcodeDir, modelProfiles: file.modelProfiles ?? [], mcpServers: file.mcpServers ?? [], activeModelProfileId,
    ...(options.allowIncomplete ? { workspace: file.workspace || (options.desktop ? '' : process.cwd()), projects: file.projects ?? [], archivedProjects: file.archivedProjects ?? [], preferences: file.preferences ?? { ...defaultPreferences }, configError } : {}),
  };
}

/** GUI 保存的是用户明确填写的配置，凭证永不进入读接口。先验证，再原子替换。 */
export class ConfigInputError extends Error {}

function workspaceDirectory(directory: unknown): string {
  try {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !statSync(directory).isDirectory()) throw new Error();
    return realpathSync(directory);
  } catch { throw new ConfigInputError('请选择存在的绝对目录'); }
}

function persistConfig(current: Config, changes: Partial<FileConfig>): void {
  let existing: FileConfig = {};
  try { existing = readJsonConfig(current.tcodeDir); } catch { /* 设置入口可修复损坏配置 */ }
  mkdirSync(current.tcodeDir, { recursive: true, mode: 0o700 });
  const file = path.join(current.tcodeDir, 'config.json');
  const temporary = path.join(current.tcodeDir, `.config-${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(temporary, JSON.stringify({ ...existing, ...changes }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { renameSync(temporary, file); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

function validatePreferences(value: unknown): asserts value is WebPreferences {
  const pref = value as WebPreferences;
  if (!pref || !['system', 'dark', 'light'].includes(pref.theme) || ![14, 16, 18].includes(pref.fontSize) || typeof pref.enterToSend !== 'boolean') {
    throw new ConfigInputError('外观须为 system、dark 或 light，字号为 14、16 或 18，发送习惯须为布尔值');
  }
}

export function saveWebPreferences(current: Config, input: Record<string, unknown>): Config {
  const preferences = { ...(current.preferences ?? defaultPreferences), ...input };
  validatePreferences(preferences);
  const saved = { theme: preferences.theme, fontSize: preferences.fontSize, enterToSend: preferences.enterToSend };
  persistConfig(current, { preferences: saved });
  return { ...current, preferences: saved };
}

/** 选目录与模型配置是独立操作；首次启动可先打开项目。 */
export function saveWorkspace(current: Config, directory: unknown): Config {
  const workspace = workspaceDirectory(directory);
  const projects = recentProjects(current, workspace);
  const archivedProjects = (current.archivedProjects ?? []).filter((directory) => directory !== workspace);
  persistConfig(current, { workspace, projects, archivedProjects });
  return { ...current, workspace, projects, archivedProjects,
    configError: current.configError?.includes('项目目录不可用') ? undefined : current.configError };
}

export function saveProjectArchive(current: Config, directory: string, archived: boolean): Config {
  if (![...(current.projects ?? []), ...(current.archivedProjects ?? []), current.workspace].includes(directory)) {
    throw new ConfigInputError('项目不在本地项目列表中');
  }
  const projects = [...new Set([...(current.projects ?? []), directory])];
  const archivedProjects = [...new Set((current.archivedProjects ?? []).filter((project) => project !== directory).concat(archived ? [directory] : []))];
  persistConfig(current, { projects, archivedProjects });
  return { ...current, projects, archivedProjects };
}

/** 移除项目只删导航记录（最近＋归档列表）；会话历史保留在数据目录，重新打开目录即可恢复。 */
export function removeProject(current: Config, directory: string): Config {
  if (![...(current.projects ?? []), ...(current.archivedProjects ?? [])].includes(directory)) {
    throw new ConfigInputError('项目不在本地项目列表中');
  }
  const projects = (current.projects ?? []).filter((project) => project !== directory);
  const archivedProjects = (current.archivedProjects ?? []).filter((project) => project !== directory);
  persistConfig(current, { projects, archivedProjects });
  return { ...current, projects, archivedProjects };
}

function recentProjects(current: Config, workspace: string): string[] {
  return [...new Set([workspace, current.workspace ?? process.cwd(), ...(current.projects ?? [])].filter(Boolean))];
}

type ModelFields = Pick<Config, 'apiKey' | 'baseUrl' | 'model' | 'protocol' | 'contextLimit'>;

function modelFields(current: ModelFields, input: Record<string, unknown>): ModelFields {
  const string = (key: string) => typeof input[key] === 'string' ? (input[key] as string).trim() : '';
  for (const key of ['apiKey', 'baseUrl', 'model', 'protocol']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new ConfigInputError('模型配置字段须为文本');
  }
  const apiKey = string('apiKey') || current.apiKey;
  const baseUrl = (input.baseUrl === undefined ? current.baseUrl : string('baseUrl')).replace(/\/+$/, '');
  if (baseUrl !== current.baseUrl.replace(/\/+$/, '') && !string('apiKey')) throw new ConfigInputError('更换模型端点须重新填写 API Key');
  const model = input.model === undefined ? current.model : string('model');
  const rawProtocol = input.protocol === undefined ? current.protocol ?? 'auto' : string('protocol') || 'auto';
  const contextLimit = Number(input.contextLimit ?? current.contextLimit);
  const modelUpdate = ['apiKey', 'baseUrl', 'model', 'protocol', 'contextLimit'].some((key) => input[key] !== undefined);
  if (modelUpdate && (!apiKey || !baseUrl || !model)) throw new ConfigInputError('请填写 API Key、端点和模型');
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new ConfigInputError('模型端点须为有效的 HTTP(S) 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ConfigInputError('模型端点须为不含用户名和密码的 HTTP(S) 地址');
  }
  if (!['auto', 'openai', 'anthropic'].includes(rawProtocol)) throw new ConfigInputError('协议须为 auto、openai 或 anthropic');
  if (!Number.isSafeInteger(contextLimit) || contextLimit <= 0) throw new ConfigInputError('上下文上限须为正整数');
  return { apiKey, baseUrl, model, protocol: rawProtocol === 'auto' ? undefined : rawProtocol as Protocol, contextLimit };
}

export function saveWebConfig(current: Config, input: Record<string, unknown>, validate?: (next: Config) => void): Config {
  const { apiKey, baseUrl, model, protocol, contextLimit } = modelFields(current, input);
  const workspace = input.workspace === undefined ? current.workspace ?? process.cwd() : workspaceDirectory(input.workspace);
  const projects = recentProjects(current, workspace);
  const approval = input.approval ?? current.approval ?? 'normal';
  if (approval !== 'normal' && approval !== 'never') throw new ConfigInputError('默认审批须为 normal 或 never');
  let allowWriteDirs = current.allowWriteDirs ?? [];
  if (input.allowWriteDirs !== undefined) {
    if (!Array.isArray(input.allowWriteDirs)) throw new ConfigInputError('免审批目录须为目录列表');
    allowWriteDirs = [...new Set(input.allowWriteDirs.map(workspaceDirectory))];
  }
  let afterTurn = current.afterTurn;
  if (input.afterTurn !== undefined) {
    if (typeof input.afterTurn !== 'string' || input.afterTurn.trim().length > 2000) throw new ConfigInputError('轮次结束钩子须为不超过 2000 字符的命令');
    afterTurn = input.afterTurn.trim() || undefined;
  }
  let beforeTurn = current.beforeTurn;
  if (input.beforeTurn !== undefined) {
    if (typeof input.beforeTurn !== 'string' || input.beforeTurn.trim().length > 2000) throw new ConfigInputError('轮次开始钩子须为不超过 2000 字符的命令');
    beforeTurn = input.beforeTurn.trim() || undefined;
  }
  const archivedProjects = (current.archivedProjects ?? []).filter((directory) => directory !== workspace);
  const modelUpdate = ['apiKey', 'baseUrl', 'model', 'protocol', 'contextLimit'].some((key) => input[key] !== undefined);
  // 顶层未命名配置的密钥：钥匙串可用时存 account=active 条目，磁盘只留引用
  const store = keyStoreFor(current.tcodeDir);
  const keyRef = apiKey && store.available ? 'active' : undefined;
  if (keyRef) setSecret(store, 'active', apiKey);
  const modelProfiles = modelUpdate ? current.modelProfiles?.map((profile) => {
    if (profile.id !== current.activeModelProfileId) return profile;
    if (keyRef) { setSecret(store, profile.id, apiKey); return { ...profile, apiKey: '', keyRef: profile.id, baseUrl, model, protocol, contextLimit }; }
    return { ...profile, apiKey, baseUrl, model, protocol, contextLimit };
  }) : current.modelProfiles;
  const next: Config = { ...current, apiKey, baseUrl, model, protocol, contextLimit, workspace, projects, archivedProjects, approval, allowWriteDirs, afterTurn, beforeTurn, modelProfiles, configError: undefined };
  validate?.(next);
  persistConfig(current, { apiKey: keyRef ? '' : apiKey, ...(keyRef ? { keyRef } : {}), baseUrl, model, protocol, contextLimit, workspace, projects, archivedProjects, approval, allowWriteDirs, afterTurn, beforeTurn, modelProfiles });
  return next;
}

/** 保存即激活；凭证沿用必须属于同一配置与同一端点。 */
export function saveModelProfile(current: Config, input: Record<string, unknown>, validate?: (next: Config) => void): Config {
  const profiles = current.modelProfiles ?? [];
  const previous = input.id === undefined ? undefined : profiles.find((profile) => profile.id === input.id);
  if (input.id !== undefined && !previous) throw new ConfigInputError('模型配置不存在');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw new ConfigInputError('配置名称须为 1 至 80 个字符');
  if (input.useActiveKey !== undefined && typeof input.useActiveKey !== 'boolean') throw new ConfigInputError('沿用当前凭证须为布尔值');
  if (input.useActiveKey && input.sourceModelProfileId !== (current.activeModelProfileId ?? null)) {
    throw new ConfigInputError('活动配置已改变，请重新填写密钥');
  }
  const normalizedUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim().replace(/\/+$/, '') : '';
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new ConfigInputError('API Key 须为文本');
  const explicitKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (input.useActiveKey && (!current.apiKey || normalizedUrl !== current.baseUrl)) throw new ConfigInputError('只有相同端点可以明确沿用当前凭证');
  const rawKey = explicitKey || (input.useActiveKey ? current.apiKey : '');
  const store = keyStoreFor(current.tcodeDir);
  const id = previous?.id ?? randomUUID();
  const keyRef = rawKey && store.available ? id : previous?.keyRef;
  if (rawKey && store.available) setSecret(store, id, rawKey);
  const key = rawKey || previous?.apiKey || '';
  // keyRef 沿用时哨兵满足"必须有凭证"校验；真实密钥由下方显式构造的 profile 决定。
  // 哨兵只限端点未变的沿用——换端点必须重填密钥，不能被哨兵绕过。
  const requestedUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim().replace(/\/+$/, '') : undefined;
  const endpointChanged = requestedUrl !== undefined && previous !== undefined && requestedUrl !== previous.baseUrl;
  const values = modelFields(previous ?? { apiKey: '', baseUrl: '', model: '', contextLimit: current.contextLimit }, { ...input, apiKey: key || (keyRef && !endpointChanged ? 'stored-in-keyring' : '') });
  // 密钥管理：钥匙串可用时明文只进钥匙串，profile 与磁盘只留引用
  let activeKey: string;
  if (keyRef) {
    if (rawKey) activeKey = rawKey;
    else {
      const secret = getSecret(store, keyRef);
      if (secret === null) throw new ConfigInputError('从钥匙串读取密钥失败，请重新填写密钥后再保存');
      activeKey = secret;
    }
  } else activeKey = key || values.apiKey;
  const profile: ModelProfile = {
    id, name: input.name.trim(), baseUrl: values.baseUrl, model: values.model,
    protocol: values.protocol, contextLimit: values.contextLimit,
    apiKey: keyRef ? '' : (rawKey || values.apiKey),
    ...(keyRef ? { keyRef } : {}),
  };
  const modelProfiles = previous ? profiles.map((entry) => entry.id === previous.id ? profile : entry) : [...profiles, profile];
  const next = { ...current, baseUrl: values.baseUrl, model: values.model, protocol: values.protocol, contextLimit: values.contextLimit,
    apiKey: activeKey, modelProfiles, activeModelProfileId: id,
    configError: current.configError?.includes('项目目录不可用') ? current.configError : undefined };
  validate?.(next);
  persistConfig(current, { baseUrl: values.baseUrl, model: values.model, protocol: values.protocol, contextLimit: values.contextLimit,
    apiKey: keyRef ? '' : profile.apiKey, ...(keyRef ? { keyRef } : {}), modelProfiles, activeModelProfileId: id });
  return next;
}

export function selectModelProfile(current: Config, id: unknown, validate?: (next: Config) => void): Config {
  const profile = typeof id === 'string' && current.modelProfiles?.find((entry) => entry.id === id);
  if (!profile) throw new ConfigInputError('模型配置不存在');
  let apiKey = profile.apiKey;
  let keyMissing: string | undefined;
  if (profile.keyRef) {
    const secret = getSecret(keyStoreFor(current.tcodeDir), profile.keyRef);
    if (secret === null) {
      // 放行激活但密钥缺失：用户可在设置里重新填写保存；失败原因进 configError 可见
      apiKey = '';
      keyMissing = '从钥匙串读取该配置的密钥失败，请在模型设置重新填写密钥';
    } else apiKey = secret;
  }
  const { baseUrl, model, protocol, contextLimit } = profile;
  const values = { apiKey, baseUrl, model, protocol, contextLimit };
  const next = { ...current, ...values, activeModelProfileId: profile.id,
    configError: keyMissing ?? (current.configError?.includes('项目目录不可用') ? current.configError : undefined) };
  validate?.(next);
  // 顶层 keyRef 与活动 profile 的引用同步，重启后才能从钥匙串恢复正确密钥
  persistConfig(current, { ...values, ...(profile.keyRef ? { keyRef: profile.keyRef } : { keyRef: undefined }), activeModelProfileId: profile.id });
  return next;
}

/** 删除模型配置只允许非活动项；凭证随配置一起删除，活动配置不受影响。 */
export function deleteModelProfile(current: Config, id: unknown): Config {
  const profiles = current.modelProfiles ?? [];
  const profile = typeof id === 'string' ? profiles.find((entry) => entry.id === id) : undefined;
  if (!profile) throw new ConfigInputError('模型配置不存在');
  if (profile.id === current.activeModelProfileId) throw new ConfigInputError('正在使用的模型配置不能删除，请先切换到其他配置');
  const modelProfiles = profiles.filter((entry) => entry.id !== profile.id);
  if (profile.keyRef) deleteSecret(keyStoreFor(current.tcodeDir), profile.keyRef);
  persistConfig(current, { modelProfiles });
  return { ...current, modelProfiles };
}

/** 保存 MCP 服务器配置（有 id 更新、无 id 新建）；仅持久化，不触碰已建立的连接。 */
export function saveMcpServer(current: Config, input: Record<string, unknown>): Config {
  const servers = [...(current.mcpServers ?? [])];
  const id = typeof input.id === 'string' && input.id ? input.id : randomUUID();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 40 || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new ConfigInputError('名称须为 1–40 个字母、数字、下划线或连字符');
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  let url: string | undefined;
  if (input.url !== undefined) {
    if (typeof input.url !== 'string') throw new ConfigInputError('MCP 端点须为 HTTP(S) 地址');
    url = input.url.trim().replace(/\/+$/, '');
    if (url) {
      try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); }
      catch { throw new ConfigInputError('MCP 端点须为 HTTP(S) 地址'); }
    }
  }
  if (!command && !url) throw new ConfigInputError('启动命令或 MCP 端点至少填写一项');
  if (command && input.url === undefined) url = undefined;
  let args: string[] | undefined;
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string')) throw new ConfigInputError('启动参数须为字符串数组');
    args = input.args as string[];
  }
  let env: Record<string, string> | undefined = servers.find((server) => server.id === id)?.env;
  if (input.env !== undefined) {
    if (typeof input.env !== 'object' || input.env === null || Array.isArray(input.env) || Object.values(input.env).some((value) => typeof value !== 'string')) throw new ConfigInputError('环境变量须为字符串到字符串的映射');
    env = input.env as Record<string, string>;
  }
  const enabled = input.enabled === true;
  const trusted = input.trusted === true;
  let trustedTools: string[] | undefined;
  if (input.trustedTools !== undefined) {
    if (!Array.isArray(input.trustedTools) || input.trustedTools.some((tool) => typeof tool !== 'string' || !tool.trim())) throw new ConfigInputError('免审批工具须为非空工具名列表');
    trustedTools = [...new Set((input.trustedTools as string[]).map((tool) => tool.trim()))];
  }
  const index = servers.findIndex((server) => server.id === id);
  const server: McpServerConfig = { id, name, command, ...(url ? { url } : {}), ...(args ? { args } : {}), ...(env ? { env } : {}), enabled, ...(trusted ? { trusted: true } : {}), ...(trustedTools ? { trustedTools } : {}) };
  if (index >= 0) servers[index] = server; else servers.push(server);
  persistConfig(current, { mcpServers: servers });
  return { ...current, mcpServers: servers };
}

export function deleteMcpServer(current: Config, id: unknown): Config {
  const mcpServers = (current.mcpServers ?? []).filter((server) => server.id !== id);
  persistConfig(current, { mcpServers });
  return { ...current, mcpServers };
}

/** 导入模型配置：传入的密钥一律忽略（凭证须在原端点重新填写），重复端点与非法条目逐条报告并跳过；不激活、不改动活动配置。 */
export function importModelProfiles(current: Config, input: unknown): { imported: number; skipped: string[]; config: Config } {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) {
    throw new ConfigInputError('导入内容须为 1–50 个模型配置的数组');
  }
  const normalize = (value: string) => value.replace(/\/+$/, '');
  const existing = new Set<string>();
  for (const profile of current.modelProfiles ?? []) existing.add(normalize(profile.baseUrl));
  if (current.baseUrl) existing.add(normalize(current.baseUrl));
  const modelProfiles = [...(current.modelProfiles ?? [])];
  const skipped: string[] = [];
  let imported = 0;
  for (const raw of input) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const fail = (reason: string) => skipped.push(`${name || '未命名'}：${reason}`);
    if (!name || name.length > 80) { fail('配置名称须为 1 至 80 个字符'); continue; }
    if (typeof entry.baseUrl !== 'string') { fail('端点须为不含用户名和密码的 HTTP(S) 地址'); continue; }
    const baseUrl = normalize(entry.baseUrl.trim());
    let url: URL;
    try { url = new URL(baseUrl); } catch { fail('端点须为不含用户名和密码的 HTTP(S) 地址'); continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { fail('端点须为不含用户名和密码的 HTTP(S) 地址'); continue; }
    if (existing.has(baseUrl)) { fail('端点已存在'); continue; }
    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (!model) { fail('模型不能为空'); continue; }
    const rawProtocol = typeof entry.protocol === 'string' && entry.protocol ? entry.protocol : 'auto';
    if (!['auto', 'openai', 'anthropic'].includes(rawProtocol)) { fail('协议须为 auto、openai 或 anthropic'); continue; }
    const contextLimit = Number(entry.contextLimit ?? current.contextLimit);
    if (!Number.isSafeInteger(contextLimit) || contextLimit <= 0) { fail('上下文上限须为正整数'); continue; }
    modelProfiles.push({ id: randomUUID(), name, baseUrl, model, apiKey: '', protocol: rawProtocol === 'auto' ? undefined : rawProtocol as Protocol, contextLimit });
    existing.add(baseUrl);
    imported++;
  }
  persistConfig(current, { modelProfiles });
  return { imported, skipped, config: { ...current, modelProfiles } };
}
