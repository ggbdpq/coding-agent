// 配置加载：环境变量 > ~/.tcode/config.json > 报错指路。
// 刻意不写死任何默认端点/模型——本地优先工具，用户自己决定请求发去哪。
// 协议选择不走这里：protocol 只有显式配置时才非空，自动识别由 provider 插件的 matches 做。
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Protocol } from './types.ts';

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
  /** 估算 token 上限，超过即触发上下文裁剪 */
  contextLimit: number;
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
  configError?: string;
}

interface FileConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  protocol?: string;
  approval?: string;
  allowWriteDirs?: string[];
  contextLimit?: number;
  workspace?: string;
  projects?: string[];
  archivedProjects?: string[];
  preferences?: WebPreferences;
  modelProfiles?: ModelProfile[];
  activeModelProfileId?: string | null;
}

function readJsonConfig(tcodeDir: string): FileConfig {
  const file = path.join(tcodeDir, 'config.json');
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const fields = value as Record<string, unknown>;
    for (const key of ['apiKey', 'baseUrl', 'model', 'protocol', 'approval', 'workspace']) {
      if (fields[key] !== undefined && typeof fields[key] !== 'string') throw new Error();
    }
    if (fields.protocol !== undefined && !['openai', 'anthropic'].includes(String(fields.protocol))) throw new Error();
    if (fields.approval !== undefined && !['normal', 'never'].includes(String(fields.approval))) throw new Error();
    if (fields.contextLimit !== undefined && (!Number.isSafeInteger(fields.contextLimit) || Number(fields.contextLimit) <= 0)) throw new Error();
    if (fields.allowWriteDirs !== undefined && (!Array.isArray(fields.allowWriteDirs) || fields.allowWriteDirs.some((dir) => typeof dir !== 'string'))) throw new Error();
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
        if (typeof profile.apiKey !== 'string' || !profile.apiKey || typeof profile.baseUrl !== 'string' || !profile.baseUrl || typeof profile.model !== 'string' || !profile.model || !Number.isSafeInteger(profile.contextLimit)) throw new Error();
        if (profile.protocol !== undefined && !['openai', 'anthropic'].includes(profile.protocol)) throw new Error();
        modelFields(profile, profile as unknown as Record<string, unknown>);
        ids.add(profile.id);
      }
    }
    if (fields.activeModelProfileId !== undefined && fields.activeModelProfileId !== null && (typeof fields.activeModelProfileId !== 'string' || !(fields.modelProfiles as ModelProfile[] | undefined)?.some((profile) => profile.id === fields.activeModelProfileId))) throw new Error();
    return value as FileConfig;
  } catch {
    throw new Error('config.json 的格式或字段无效，请在模型设置中重新保存');
  }
}

export function loadConfig(options: { allowIncomplete?: boolean; desktop?: boolean } = {}): Config {
  const tcodeDir = path.resolve(process.env.TCODE_DATA_DIR || path.join(homedir(), '.tcode'));
  let file: FileConfig = {};
  let configError: string | undefined;
  try { file = readJsonConfig(tcodeDir); }
  catch (error) {
    if (!options.allowIncomplete) throw error;
    configError = (error as Error).message;
  }
  const apiKey = process.env.TCODE_API_KEY ?? file.apiKey ?? '';
  const baseUrl = (process.env.TCODE_BASE_URL ?? file.baseUrl ?? '').replace(/\/+$/, '');
  const model = process.env.TCODE_MODEL ?? file.model ?? '';
  const contextLimit = Number(process.env.TCODE_CONTEXT_LIMIT || file.contextLimit) || 100_000;

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
  const activeModelProfileId = selected && selected.apiKey === apiKey && selected.baseUrl === baseUrl && selected.model === model
    && selected.protocol === protocol && selected.contextLimit === contextLimit ? selected.id : null;
  return { apiKey, baseUrl, model, protocol, approval, allowWriteDirs, contextLimit, tcodeDir, modelProfiles: file.modelProfiles ?? [], activeModelProfileId,
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
  const archivedProjects = (current.archivedProjects ?? []).filter((directory) => directory !== workspace);
  const modelUpdate = ['apiKey', 'baseUrl', 'model', 'protocol', 'contextLimit'].some((key) => input[key] !== undefined);
  const modelProfiles = modelUpdate ? current.modelProfiles?.map((profile) => profile.id === current.activeModelProfileId
    ? { ...profile, apiKey, baseUrl, model, protocol, contextLimit } : profile) : current.modelProfiles;
  const next: Config = { ...current, apiKey, baseUrl, model, protocol, contextLimit, workspace, projects, archivedProjects, approval, allowWriteDirs, modelProfiles, configError: undefined };
  validate?.(next);
  persistConfig(current, { apiKey, baseUrl, model, protocol, contextLimit, workspace, projects, archivedProjects, approval, allowWriteDirs, modelProfiles });
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
  const key = explicitKey || (input.useActiveKey ? current.apiKey : '');
  const values = modelFields(previous ?? { apiKey: '', baseUrl: '', model: '', contextLimit: current.contextLimit }, { ...input, apiKey: key });
  const profile: ModelProfile = { id: previous?.id ?? randomUUID(), name: input.name.trim(), ...values };
  const modelProfiles = previous ? profiles.map((entry) => entry.id === previous.id ? profile : entry) : [...profiles, profile];
  const next = { ...current, ...values, modelProfiles, activeModelProfileId: profile.id,
    configError: current.configError?.includes('项目目录不可用') ? current.configError : undefined };
  validate?.(next);
  persistConfig(current, { ...values, modelProfiles, activeModelProfileId: profile.id });
  return next;
}

export function selectModelProfile(current: Config, id: unknown, validate?: (next: Config) => void): Config {
  const profile = typeof id === 'string' && current.modelProfiles?.find((entry) => entry.id === id);
  if (!profile) throw new ConfigInputError('模型配置不存在');
  const { apiKey, baseUrl, model, protocol, contextLimit } = profile;
  const values = { apiKey, baseUrl, model, protocol, contextLimit };
  const next = { ...current, ...values, activeModelProfileId: profile.id,
    configError: current.configError?.includes('项目目录不可用') ? current.configError : undefined };
  validate?.(next);
  persistConfig(current, { ...values, activeModelProfileId: profile.id });
  return next;
}
