using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.plugins.tools;

public sealed record EditResult(bool Ok, string Message);

/// <summary>edit 工具：精确字符串替换——coding agent 改代码的主力。
/// old_string 必须在文件中唯一（否则要求补上下文或显式 replace_all），防止误伤。
/// 路径先过守卫：越出工作目录的编辑在权限确认时醒目提示。</summary>
public sealed class EditTool : ToolPlugin
{
    public override string Name => "edit";
    public override string Description =>
        "对文件做精确字符串替换：old_string 必须与文件内容完全一致（含缩进）。多处出现且需全部替换时设 replace_all=true。";
    public override JsonObject? Parameters => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["file_path"] = new JsonObject { ["type"] = "string", ["description"] = "目标文件路径" },
            ["old_string"] = new JsonObject { ["type"] = "string", ["description"] = "要被替换的精确原文" },
            ["new_string"] = new JsonObject { ["type"] = "string", ["description"] = "替换后的新文本" },
            ["replace_all"] = new JsonObject { ["type"] = "boolean", ["description"] = "全部替换，默认 false" },
        },
        ["required"] = new JsonArray("file_path", "old_string", "new_string"),
    };
    public override bool NeedsPermission => true;

    /// <summary>白名单免确认（R4，与 write 同规则）：目标在 config.AllowWriteDirs 内。</summary>
    public override bool SkipPermission(JsonObject args, App app) =>
        PathGuard.InsideAllowDirs(JsonUtil.Str(args["file_path"]) ?? "", app.Config.AllowWriteDirs);

    public override string Preview(JsonObject args)
    {
        var file = JsonUtil.Str(args["file_path"]) ?? "";
        var outside = PathGuard.Resolve(file).Outside;
        var flag = outside ? "\n⚠ 注意：该路径在当前工作目录之外！" : "";
        var oldString = JsonUtil.Str(args["old_string"]) ?? "";
        var newString = JsonUtil.Str(args["new_string"]) ?? "";
        return $"编辑 {file}{flag}\n{Ui.PreviewDiff(oldString, newString)}";
    }

    public override async Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken)
    {
        var file = JsonUtil.Str(args["file_path"]) ?? "";
        if (file.Length == 0) return "错误：缺少 file_path";
        var oldString = JsonUtil.Str(args["old_string"]) ?? "";
        var newString = JsonUtil.Str(args["new_string"]) ?? "";
        var replaceAll = JsonUtil.Bool(args["replace_all"]);
        var abs = PathGuard.Resolve(file).Abs;

        string content;
        try
        {
            content = File.ReadAllText(abs);
        }
        catch
        {
            return $"错误：无法读取 {file}（不存在或不可读）";
        }
        var check = ApplyEdit(content, oldString, newString, replaceAll);
        if (!check.Ok) return check.Message;
        var next = replaceAll ? content.Replace(oldString, newString) : ReplaceFirst(content, oldString, newString);
        await File.WriteAllTextAsync(abs, next, Ui.Utf8NoBom, cancellationToken);
        var count = replaceAll ? CountOccurrences(content, oldString) : 1;
        return $"已替换 {file} 中 {count} 处内容";
    }

    /// <summary>纯函数（TDD 接缝）：在 content 上执行一次精确替换的判定，不做 IO。</summary>
    public static EditResult ApplyEdit(string content, string oldString, string newString, bool replaceAll)
    {
        if (oldString.Length == 0) return new EditResult(false, "错误：old_string 不能为空");
        var count = CountOccurrences(content, oldString);
        if (count == 0)
            return new EditResult(false, "错误：未找到 old_string，请先 read 文件核对精确内容（含缩进与换行）");
        if (count > 1 && !replaceAll)
            return new EditResult(false,
                $"错误：old_string 出现了 {count} 次。请加入更多上下文使其唯一；确认要全部替换时设 replace_all=true");
        return new EditResult(true, replaceAll ? "all" : "one");
    }

    internal static int CountOccurrences(string content, string needle) => content.Split(needle).Length - 1;

    // apply_patch 复用同一处"只替换首处"的语义（与 tcode 的 replace(old, new) 一致）
    internal static string ReplaceFirst(string content, string oldString, string newString)
    {
        var index = content.IndexOf(oldString, StringComparison.Ordinal);
        return index < 0 ? content : content[..index] + newString + content[(index + oldString.Length)..];
    }
}
