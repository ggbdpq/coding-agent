// 重试纪律：两种协议客户端共用。仅首字节前可重试（流已开始的中断不重试，避免内容重复）。
import type { CompletionResult } from '../kernel/types.ts';

/** 标记可重试的错误（HTTP 429/5xx、网络层失败）；流已开始后不重试 */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** 最多 3 次尝试，指数退避；AbortError 视为用户中止，绝不重试 */
export async function withRetry(run: () => Promise<CompletionResult>): Promise<CompletionResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run();
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      const retryable = e instanceof RetryableError || e instanceof TypeError;
      if (!retryable || attempt === 2) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}
