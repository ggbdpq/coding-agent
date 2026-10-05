// 模型发现：OpenAI 兼容 GET {baseUrl}/models，Anthropic GET {baseUrl}/v1/models。
// 只读探测；错误正文原样抛出，由调用方做凭证遮蔽与截断（先遮蔽后截断，防止半截密钥回显）。
export type DiscoveryProtocol = 'openai' | 'anthropic';

export async function listModels(baseUrl: string, apiKey: string, protocol: DiscoveryProtocol, signal: AbortSignal): Promise<string[]> {
  const headers: Record<string, string> = protocol === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` };
  const res = await fetch(`${baseUrl}${protocol === 'anthropic' ? '/v1/models' : '/models'}`, { headers, signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}：${text || res.statusText}`);
  }
  const body = await res.json() as { data?: Array<{ id?: unknown }> };
  const ids = (Array.isArray(body.data) ? body.data : [])
    .map((entry) => String(entry?.id ?? ''))
    .filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export interface AccountBalance {
  isAvailable: boolean;
  currency: string;
  totalBalance: string;
  grantedBalance: string | null;
  toppedUpBalance: string | null;
}

/** 账户余额：DeepSeek 形状 GET {baseUrl}/user/balance（Bearer）；错误正文原样抛出，由调用方遮蔽后截断。 */
export async function fetchBalance(baseUrl: string, apiKey: string, signal: AbortSignal): Promise<AccountBalance> {
  const res = await fetch(`${baseUrl}/user/balance`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}：${text || res.statusText}`);
  }
  const body = await res.json() as {
    is_available?: unknown;
    balance_infos?: Array<{ currency?: unknown; total_balance?: unknown; granted_balance?: unknown; topped_up_balance?: unknown }>;
  };
  const info = Array.isArray(body.balance_infos) ? body.balance_infos[0] : undefined;
  if (!info || typeof info.total_balance !== 'string') throw new Error('端点未返回可识别的余额信息');
  return {
    isAvailable: body.is_available === true,
    currency: String(info.currency ?? ''),
    totalBalance: info.total_balance,
    grantedBalance: typeof info.granted_balance === 'string' ? info.granted_balance : null,
    toppedUpBalance: typeof info.topped_up_balance === 'string' ? info.topped_up_balance : null,
  };
}
