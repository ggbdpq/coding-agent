using ccode.kernel;

namespace ccode.providers;

/// <summary>标记可重试的错误（HTTP 429/5xx、网络层失败）；流已开始后的中断不重试，避免内容重复。</summary>
public sealed class RetryableException(string message) : Exception(message);

/// <summary>
/// 重试纪律：两种协议客户端共用。最多 3 次尝试，指数退避 1s/2s。
/// "仅首字节前可重试"由错误类型编码：只有 RetryableException / HttpRequestException
/// 这两种发生在收到响应头之前的错误会触发重试；流读循环里的异常类型不在其列。
/// 用户取消（OperationCanceledException，含 Ctrl+C 触发的取消令牌）绝不重试。
/// </summary>
public static class Retry
{
    public static async Task<CompletionResult> WithRetryAsync(
        Func<Task<CompletionResult>> attempt, CancellationToken cancellationToken)
    {
        for (var round = 0; ; round++)
        {
            try
            {
                return await attempt();
            }
            catch (OperationCanceledException)
            {
                throw; // 用户取消：绝不重试
            }
            catch (Exception e) when (e is RetryableException or HttpRequestException)
            {
                if (round >= 2) throw;
                await Task.Delay(TimeSpan.FromSeconds(1 << round), cancellationToken); // 1s、2s；退避中取消立即中止
            }
        }
    }
}
