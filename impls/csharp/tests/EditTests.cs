using ccode.plugins.tools;

namespace ccode.tests;

/// <summary>TDD 切片1：ApplyEdit 纯函数判定表。</summary>
internal static class EditTests
{
    public static void All()
    {
        Runner.Case("edit：空 old_string 拒绝", () =>
        {
            var result = EditTool.ApplyEdit("abc", "", "x", replaceAll: false);
            Check.True(!result.Ok, "应判定失败");
            Check.Eq("错误：old_string 不能为空", result.Message);
        });
        Runner.Case("edit：未找到 old_string", () =>
        {
            var result = EditTool.ApplyEdit("abc", "zzz", "x", replaceAll: false);
            Check.True(!result.Ok, "应判定失败");
            Check.Eq("错误：未找到 old_string，请先 read 文件核对精确内容（含缩进与换行）", result.Message);
        });
        Runner.Case("edit：多处出现且未开 replace_all 拒绝并提示次数", () =>
        {
            var result = EditTool.ApplyEdit("abab", "ab", "c", replaceAll: false);
            Check.True(!result.Ok, "应判定失败");
            Check.Eq("错误：old_string 出现了 2 次。请加入更多上下文使其唯一；确认要全部替换时设 replace_all=true",
                result.Message);
        });
        Runner.Case("edit：多处出现 + replace_all 放行，档位 all", () =>
        {
            var result = EditTool.ApplyEdit("abab", "ab", "c", replaceAll: true);
            Check.True(result.Ok, "应判定成功");
            Check.Eq("all", result.Message);
        });
        Runner.Case("edit：唯一命中，档位 one", () =>
        {
            var result = EditTool.ApplyEdit("abc", "b", "X", replaceAll: false);
            Check.True(result.Ok, "应判定成功");
            Check.Eq("one", result.Message);
        });
        Runner.Case("edit：空内容里任何 old_string 都未找到", () =>
        {
            var result = EditTool.ApplyEdit("", "a", "b", replaceAll: false);
            Check.True(!result.Ok, "应判定失败");
        });
        Runner.Case("edit：判定与次数统计对多行内容同样成立", () =>
        {
            var content = "line1\nline2\nline1";
            var result = EditTool.ApplyEdit(content, "line1", "gone", replaceAll: false);
            Check.True(!result.Ok, "出现 2 次应拒绝");
            Check.Contains("出现了 2 次", result.Message, "错误信息");
        });
    }
}
