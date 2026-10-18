// macOS 钥匙串薄封装：API 密钥不落 config.json，只存引用（keyRef）。
// security CLI 不可用（Linux/Windows）或 TCODE_KEYSTORE=off 时回退明文落盘（旧行为）。
// service 按数据目录派生，多数据目录（含测试）互不干扰。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface KeyStore {
  service: string;
  available: boolean;
}

let cached: { dir: string; store: KeyStore } | null = null;

export function keyStoreFor(tcodeDir: string): KeyStore {
  if (cached?.dir === tcodeDir) return cached.store;
  let available = false;
  if (process.env.TCODE_KEYSTORE !== 'off') {
    try { execFileSync('security', ['-h'], { stdio: 'ignore' }); available = true; } catch { available = false; }
  }
  const store: KeyStore = { service: 'tcode:' + createHash('sha256').update(tcodeDir).digest('hex').slice(0, 16), available };
  cached = { dir: tcodeDir, store };
  return store;
}

// 进程内密钥缓存：keyRef → 明文。写入/读取时填充，供错误遮蔽等同步路径零成本取用。
const secrets = new Map<string, string>();

export function setSecret(store: KeyStore, account: string, value: string): void {
  execFileSync('security', ['add-generic-password', '-U', '-s', store.service, '-a', account, '-w', value], { stdio: 'ignore' });
  secrets.set(store.service + '/' + account, value);
}

export function getSecret(store: KeyStore, account: string): string | null {
  const cacheKey = store.service + '/' + account;
  const cached = secrets.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    // security -w 输出带尾换行；不 trim 会污染 Authorization 头
    const value = execFileSync('security', ['find-generic-password', '-s', store.service, '-a', account, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    secrets.set(cacheKey, value);
    return value;
  } catch {
    return null;
  }
}

/** 只读缓存：不碰钥匙串；用于错误遮蔽等同步路径 */
export function peekSecret(store: KeyStore, account: string | undefined): string | null {
  if (!account) return null;
  return secrets.get(store.service + '/' + account) ?? null;
}

export function deleteSecret(store: KeyStore, account: string): void {
  try { execFileSync('security', ['delete-generic-password', '-s', store.service, '-a', account], { stdio: 'ignore' }); } catch {}
  secrets.delete(store.service + '/' + account);
}
