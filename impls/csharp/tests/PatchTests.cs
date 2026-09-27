using System.Text.Json.Nodes;
using ccode.plugins.tools;

namespace ccode.tests;

/// <summary>
/// apply_patch 原子补丁单测：全预验通过才写入；任一失败零写入并逐条报告。
/// 镜像 tcode/test/patch.test.ts；临时目录用 Path.GetTempPath() 下建唯一目录并在 finally 清理。
/// </summary>
internal static class PatchTests
{
    private static (string Dir, string A, string B) Setup()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ccode-patch-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var a = Path.Combine(dir, "a.txt");
        var b = Path.Combine(dir, "b.txt");
        File.WriteAllText(a, "alpha\nbeta\n");
        File.WriteAllText(b, "hello\n");
        return (dir, a, b);
    }

    private static JsonObject Edit(string file, string oldString, string newString, bool? replaceAll = null)
    {
        var edit = new JsonObject
        {
            ["file_path"] = file,
            ["old_string"] = oldString,
            ["new_string"] = newString,
        };
        if (replaceAll is { } flag) edit["replace_all"] = flag;
        return edit;
    }

    public static void All()
    {
        var tool = new ApplyPatchTool();

        Runner.Case("patch：全部预验通过，多文件一次应用", () =>
        {
            var (dir, a, b) = Setup();
            try
            {
                var result = tool.RunAsync(new JsonObject
                {
                    ["edits"] = new JsonArray(Edit(a, "alpha", "ALPHA"), Edit(b, "hello", "HELLO")),
                }, CancellationToken.None).GetAwaiter().GetResult();
                Check.Contains("已应用补丁：2 处编辑", result, "返回串");
                Check.Eq("ALPHA\nbeta\n", File.ReadAllText(a), "a.txt 内容");
                Check.Eq("HELLO\n", File.ReadAllText(b), "b.txt 内容");
            }
            finally
            {
                Directory.Delete(dir, true);
            }
        });

        Runner.Case("patch：任一失败零写入并逐条报告", () =>
        {
            var (dir, a, b) = Setup();
            try
            {
                var result = tool.RunAsync(new JsonObject
                {
                    ["edits"] = new JsonArray(Edit(a, "alpha", "ALPHA"), Edit(b, "不存在的原文", "X")),
                }, CancellationToken.None).GetAwaiter().GetResult();
                Check.Contains("预验未通过", result, "返回串");
                Check.Contains("未找到 old_string", result, "返回串");
                Check.Eq("alpha\nbeta\n", File.ReadAllText(a), "失败时 a 不应被改动");
                Check.Eq("hello\n", File.ReadAllText(b), "b 不应被改动");
            }
            finally
            {
                Directory.Delete(dir, true);
            }
        });

        Runner.Case("patch：多处出现未指定 replace_all 拒绝该条", () =>
        {
            var (dir, a, _) = Setup();
            try
            {
                var result = tool.RunAsync(new JsonObject
                {
                    ["edits"] = new JsonArray(Edit(a, "a", "A")),
                }, CancellationToken.None).GetAwaiter().GetResult();
                Check.Contains("出现 3 次", result, "返回串");
                Check.Eq("alpha\nbeta\n", File.ReadAllText(a), "拒绝时零写入");
            }
            finally
            {
                Directory.Delete(dir, true);
            }
        });
    }
}
