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
}
