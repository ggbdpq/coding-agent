using System.Text;

namespace ccode.kernel;

/// <summary>
/// 终端着色与截断：零依赖 ANSI，仅在 TTY 上着色（重定向/冒烟测试输出保持干净）。
/// 放 kernel：core 与 plugins 两层都要用，属共享工具。
/// </summary>
public static class Ui
{
    private static readonly bool Tty = !Console.IsOutputRedirected;

    /// <summary>写文件统一 UTF-8 无 BOM（与 tcode writeFileSync utf8 语义一致）。</summary>
    public static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    private static string Wrap(string code, string s) => Tty ? $"\x1b[{code}m{s}\x1b[0m" : s;

    public static string Dim(string s) => Wrap("2", s);
    public static string Cyan(string s) => Wrap("36", s);
    public static string Green(string s) => Wrap("32", s);
    public static string Yellow(string s) => Wrap("33", s);
    public static string Red(string s) => Wrap("31", s);
    public static string Bold(string s) => Wrap("1", s);

    /// <summary>超长文本截断，末尾标注省略了多少字符。</summary>
    public static string Ellipsis(string s, int max) =>
        s.Length <= max ? s : $"{s[..max]}\n…（已截断，省略 {s.Length - max} 字符）";

    /// <summary>
    /// 旧文本 → 新文本的简易行级 diff 预览（前缀 +/-，保留两侧公共首尾行减少噪音）。
    /// 不做 LCS 最小 diff——确认预览要的是"改了什么"而非"最短编辑脚本"；
    /// 需要精确 diff 时升级为独立渲染器。
    /// </summary>
    public static string PreviewDiff(string oldText, string newText, int maxLines = 40)
    {
        var oldLines = oldText.Split('\n');
        var newLines = newText.Split('\n');
        // 公共前缀/后缀（后缀不含与前缀重叠的部分）
        var pre = 0;
        while (pre < oldLines.Length && pre < newLines.Length && oldLines[pre] == newLines[pre]) pre++;
        var suf = 0;
        while (suf < oldLines.Length - pre && suf < newLines.Length - pre &&
               oldLines[oldLines.Length - 1 - suf] == newLines[newLines.Length - 1 - suf])
            suf++;
        var removed = oldLines[pre..(oldLines.Length - suf)].Select(l => $"-{l}");
        var added = newLines[pre..(newLines.Length - suf)].Select(l => $"+{l}");
        var ctxBefore = oldLines[Math.Max(0, pre - 2)..pre].Select(l => $" {l}");
        var afterStart = newLines.Length - suf;
        var ctxAfter = newLines[afterStart..Math.Min(newLines.Length, afterStart + 2)].Select(l => $" {l}");
        var lines = new List<string>();
        lines.AddRange(ctxBefore);
        lines.AddRange(removed);
        lines.AddRange(added);
        lines.AddRange(ctxAfter);
        var body = string.Join("\n", lines.Take(maxLines));
        return lines.Count > maxLines ? $"{body}\n…（diff 共 {lines.Count} 行，已截断）" : body;
    }
}
