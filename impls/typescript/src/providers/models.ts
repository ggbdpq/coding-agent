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
