using System.Text;
using System.Text.RegularExpressions;

namespace ccode.core;

/// <summary>
/// @文件引用（v0.4-2）：把输入里的 @path 注入对应文件内容。
/// ExpandAtRefs 是纯函数（读文件经参数注入，方便单测）；只读不写，无需权限闸门。
/// 路径含空格不支持（@token 以空白分隔）；@目录 不展开——需要时升级。
/// REPL 与 exec 壳共用同一实现。
/// </summary>
public static partial class AtRefs
{
    /// <summary>注入正文的大小上限（256KB），超出截断并标注。</summary>
    public const int MaxFileChars = 256 * 1024;

    [GeneratedRegex(@"(^|\s)@([^\s@]+)")]
    private static partial Regex AtRefRegex();

    /// <summary>把 line 里的每个 @path 替换为 [引用文件 …] 内容块；读不到标注缺失，不报错。</summary>
    public static string ExpandAtRefs(string line, Func<string, string?> readFile) =>
        AtRefRegex().Replace(line, match =>
        {
            var lead = match.Groups[1].Value;
            var rawPath = match.Groups[2].Value;
            var content = readFile(rawPath);
            if (content is null) return $"{lead}@{rawPath}（文件不存在）";
            var body = content.Length > MaxFileChars
                ? $"{content[..MaxFileChars]}\n…（已截断，原文 {content.Length} 字符）"
                : content;
            return $"{lead}[引用文件 {rawPath}]\n{body}\n[/引用文件]";
        });

    /// <summary>壳注入的默认读文件：1MB 内全读（与 tcode 的 cappedRead 同语义），缺失/目录/异常返回 null。</summary>
    public static string? CappedRead(string path)
    {
        try
        {
            var abs = Path.GetFullPath(path);
            if (Directory.Exists(abs)) return null;
            using var stream = File.OpenRead(abs);
            var buffer = new byte[Math.Min(stream.Length, 1024 * 1024)];
            stream.ReadExactly(buffer);
            return Encoding.UTF8.GetString(buffer);
        }
        catch
        {
            return null;
        }
    }
}
