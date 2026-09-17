using System.Net;
using System.Runtime.CompilerServices;
using System.Text;

namespace ccode.providers;

/// <summary>
/// 共用 HttpClient：总超时关掉（由每次请求自己链出的取消令牌管）；
/// 关自动重定向——web_fetch 手动逐跳过 SSRF 复检，杜绝"公网 302 跳内网"。
/// </summary>
public static class SharedHttp
{
    public static readonly HttpClient Client = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
    })
    {
        Timeout = Timeout.InfiniteTimeSpan,
    };
}

/// <summary>SSE 共用件：从响应体流中逐事件产出 data 字段内容，OpenAI 与 Anthropic 两种协议通用。
/// 取消令牌贯穿读循环：用户 Ctrl+C 时 ReadLineAsync 抛 OperationCanceledException，HTTP 请求真正中断。</summary>
public static class Sse
{
    public static async IAsyncEnumerable<string> DataAsync(Stream body,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        using var reader = new StreamReader(body, Encoding.UTF8);
        var block = new List<string>();
        while (true)
        {
            string? line;
            try
            {
                line = await reader.ReadLineAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw; // 用户取消：流读循环中断，绝不当作"流结束"静默收尾
            }
            if (line is null) break;
            if (line.Length == 0)
            {
                // 空行 = 事件边界；统一换行符由 ReadLine 处理，\r\n 不会切碎事件
                var data = JoinData(block);
                block.Clear();
                if (data.Length > 0) yield return data;
                continue;
            }
            block.Add(line);
        }
        var tail = JoinData(block); // 流结束时残留的最后一个事件
        if (tail.Length > 0) yield return tail;
    }

    /// <summary>一个事件块里所有 data: 行的载荷，多行以 \n 连接。</summary>
    private static string JoinData(List<string> block) => string.Join("\n",
        block.Where(l => l.StartsWith("data:")).Select(l => l.Substring(5).Trim()));
}
