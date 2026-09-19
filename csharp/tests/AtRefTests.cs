using ccode.core;

namespace ccode.tests;

/// <summary>
/// @文件引用解析单测（v0.4-2）：输入中的 @path 注入文件内容，缺文件/超限如实标注。
/// 镜像 tcode/test/atrefs.test.ts。ExpandAtRefs 是纯函数，读文件经参数注入。
/// </summary>
internal static class AtRefTests
{
    private static Func<string, string?> FakeRead(Dictionary<string, string> files) =>
        p => files.TryGetValue(p, out var value) ? value : null;

    public static void All()
    {
        Runner.Case("atrefs：无 @ 引用时原样返回（邮箱不误伤）", () =>
        {
            Check.Eq("普通输入", AtRefs.ExpandAtRefs("普通输入", FakeRead([])), "普通文本");
            Check.Eq("邮箱 someone@example.com",
                AtRefs.ExpandAtRefs("邮箱 someone@example.com", FakeRead([])),
                "@ 前无空白/行首时不展开");
        });

        Runner.Case("atrefs：@path 替换为文件内容块", () =>
        {
            var output = AtRefs.ExpandAtRefs("看看 @src/a.ts 说明了什么", FakeRead(new() { ["src/a.ts"] = "hello" }));
            Check.Contains("看看", output, "保留原句");
            Check.Contains("[引用文件 src/a.ts]", output, "有引用头");
            Check.Contains("hello", output, "有文件内容");
        });

        Runner.Case("atrefs：多个 @ 引用各自注入", () =>
        {
            var output = AtRefs.ExpandAtRefs("@a.txt 和 @b.txt",
                FakeRead(new() { ["a.txt"] = "AAA", ["b.txt"] = "BBB" }));
            Check.Contains("AAA", output, "第一个引用");
            Check.Contains("BBB", output, "第二个引用");
        });

        Runner.Case("atrefs：文件不存在 → 标注缺失而非报错", () =>
        {
            var output = AtRefs.ExpandAtRefs("看看 @ghost.ts", FakeRead([]));
            Check.Contains("@ghost.ts（文件不存在）", output, "缺失标注");
        });

        Runner.Case("atrefs：超长文件 256KB 截断", () =>
        {
            var output = AtRefs.ExpandAtRefs("看 @big.txt", FakeRead(new() { ["big.txt"] = new string('x', 300_000) }));
            Check.True(output.Length < 300_000, $"截断后应小于原文长度，实际 {output.Length}");
            Check.Contains("已截断", output, "截断标注");
        });
    }
}
