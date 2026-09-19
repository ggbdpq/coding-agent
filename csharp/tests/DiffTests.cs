using ccode.kernel;

namespace ccode.tests;

/// <summary>diff 预览单测：前缀 +/-、公共上下文收敛、截断标注。镜像 tcode/test/diff.test.ts。</summary>
internal static class DiffTests
{
    public static void All()
    {
        Runner.Case("diff：相同文本无 +/- 行", () =>
        {
            var d = Ui.PreviewDiff("a\nb", "a\nb");
            Check.True(!d.Contains("-a") && !d.Contains("+a"), "相同文本不应出现 +/- 行");
        });

        Runner.Case("diff：替换显示 - 旧行与 + 新行", () =>
        {
            var d = Ui.PreviewDiff("old line", "new line");
            Check.Contains("-old line", d, "旧行前缀 -");
            Check.Contains("+new line", d, "新行前缀 +");
        });

        Runner.Case("diff：多行修改保留上下文顺序", () =>
        {
            var d = Ui.PreviewDiff("a\nb\nc", "a\nB\nc");
            Check.True(d.Contains(" a") && d.Contains(" c"), "公共行保留（空格前缀）");
            Check.True(d.Contains("-b") && d.Contains("+B"), "变更行带 -/+ 前缀");
        });
    }
}
