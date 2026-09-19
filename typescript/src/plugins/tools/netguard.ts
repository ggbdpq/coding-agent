// 网络守卫：web_fetch 的 SSRF 防线（平台安全基线的实现验收条件）。
// 规则：仅 http/https；拒绝会解析到环回/私有/保留地址的主机；重定向逐跳复检。
// 纯函数部分（协议/字面 IP）独立导出方便单测，DNS 部分单独一个入口。
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  url?: URL;
}

/** 协议与主机名字面校验（不含 DNS） */
export function checkUrlLiteral(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: '错误：URL 无法解析' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `错误：只允许 http/https 协议，收到 ${url.protocol}` };
  }
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: '错误：URL 缺少主机名' };
  if (isLiteralBlocked(host)) {
    return { ok: false, reason: `错误：拒绝访问私有/保留地址：${host}（已拦截，SSRF 防护）` };
  }
  return { ok: true, url };
}

/** 主机名是字面 IP 或保留域名时的直接判定；普通域名返回 false（交给 DNS 复检） */
function isLiteralBlocked(host: string): boolean {
  // WHATWG URL 对 IPv6 字面量的 hostname 保留方括号（如 [::1]），先剥掉
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) {
    return true;
  }
  if (isIP(h) === 4) return !isPublicIPv4(h);
  if (isIP(h) === 6) return !isPublicIPv6(h);
  return false;
}

/** IPv4 是否公网。覆盖常见保留段；清单取向是"保守拒绝" */
export function isPublicIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return false; // 本网络 / 私有 / 环回
  if (a === 169 && b === 254) return false; // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return false; // 私有
  if (a === 192 && b === 168) return false; // 私有
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return false; // 基准测试
  if (a >= 224) return false; // 组播 + 保留 + 广播
  return true;
}

/** IPv6 是否公网。环回/ULA/链路本地/IPv4 映射回 v4 判定，其余保守放行 */
export function isPublicIPv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === '::' || h === '::1') return false; // 未指定 / 环回
  if (/^fe[89ab]/.test(h)) return false; // 链路本地 fe80::/10
  if (h.startsWith('fc') || h.startsWith('fd')) return false; // ULA fc00::/7
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4 映射地址拆回 v4 判
  if (mapped) return isPublicIPv4(mapped[1]);
  if (h.startsWith('::ffff:')) return false; // 非点分映射形式，保守拒绝
  if (h.startsWith('64:ff9b')) return false; // NAT64 已知前缀，保守拒绝
  return true;
}

/** DNS 复检：任一解析结果不公开即拒绝（防域名指内网的绕行） */
export async function assertResolvesPublic(hostname: string): Promise<void> {
  const addrs = await lookup(hostname, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error(`错误：${hostname} 没有解析到任何地址`);
  for (const { address } of addrs) {
    const publicAddr = isIP(address) === 4 ? isPublicIPv4(address) : isPublicIPv6(address);
    if (!publicAddr) {
      throw new Error(`错误：${hostname} 解析到私有/保留地址 ${address}（已拦截，SSRF 防护）`);
    }
  }
}
