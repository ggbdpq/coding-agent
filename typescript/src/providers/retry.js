/** 标记可重试的错误（HTTP 429/5xx、网络层失败）；流已开始后不重试 */
export class RetryableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RetryableError';
    }
}
/** 最多 3 次尝试，指数退避；AbortError 视为用户中止，绝不重试 */
export async function withRetry(run) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await run();
        }
        catch (e) {
            if (e.name === 'AbortError')
                throw e;
            const retryable = e instanceof RetryableError || e instanceof TypeError;
            if (!retryable || attempt === 2)
                throw e;
            lastErr = e;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
    }
    throw lastErr;
}
