// App：插件的运行环境——命令与壳通过它拿能力，彼此互不 import。
// kernel 不 import core：store 与 freshMessages 由装配方（main）注入，
// 这里只声明最小的结构化接口。
import type { Config } from './config.ts';
import type { Registry } from './registry.ts';
import type { ChatClient, ChatMessage, YoloRef } from './types.ts';

export const VERSION = '0.2.0';

/** core/session.SessionStore 满足此结构（kernel 不直接依赖 core） */
export interface SessionStoreLike {
  start(meta?: Record<string, unknown>): void;
  append(message: ChatMessage): void;
  listRecent(n: number): Array<{ file: string; mtime: number; label: string }>;
  load(file: string): ChatMessage[];
}

export interface AppOptions {
  yolo: boolean;
  /** 产出全新消息数组（system 提示词），由装配方注入（依赖 core/systemprompt） */
  freshMessages: () => ChatMessage[];
  store: SessionStoreLike;
}

export interface App {
  config: Config;
  registry: Registry;
  provider: ChatClient;
  store: SessionStoreLike;
  yolo: YoloRef;
  /** 当前会话消息；命令/壳直接读写这个数组 */
  messages: ChatMessage[];
  /** 开新会话文件（/new、/resume 都换文件，永不追加旧文件） */
  startSession(extra?: Record<string, unknown>): void;
  /** messages 换成全新 system 数组 */
  resetMessages(): void;
}

export function createApp(config: Config, registry: Registry, opts: AppOptions): App {
  const provider = selectProvider(config, registry);
  const yolo: YoloRef = { value: opts.yolo };
  const app: App = {
    config,
    registry,
    provider,
    store: opts.store,
    yolo,
    messages: [],
    startSession(extra: Record<string, unknown> = {}) {
      opts.store.start({
        version: VERSION,
        model: config.model,
        cwd: process.cwd(),
        yolo: yolo.value,
        ...extra,
      });
    },
    resetMessages() {
      app.messages = opts.freshMessages();
    },
  };
  app.resetMessages();
  app.startSession();
  return app;
}

/** 显式配置的 protocol 按名选；否则按注册顺序取首个 matches 命中的 provider */
function selectProvider(config: Config, registry: Registry): ChatClient {
  if (config.protocol) {
    const explicit = registry.providers().find((p) => p.name === config.protocol);
    if (!explicit) {
      throw new Error(
        `没有名为 ${config.protocol} 的 provider 插件（可用：${registry
          .providers()
          .map((p) => p.name)
          .join(', ')}）`
      );
    }
    return explicit.create(config);
  }
  const hit = registry.providers().find((p) => p.matches(config.baseUrl));
  if (!hit) throw new Error(`没有 provider 插件能处理 BASE_URL：${config.baseUrl}`);
  return hit.create(config);
}
