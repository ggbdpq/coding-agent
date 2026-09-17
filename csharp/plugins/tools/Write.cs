using System.Text.Json;
using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.plugins.tools;

/// <summary>write 工具：整文件写入（新文件/整体重写），自动建父目录。
/// 模型给的路径先过路径守卫：越出工作目录的目标在权限确认时醒目提示，由人工把关。</summary>
public sealed class WriteTool : ToolPlugin
{
    public override string Name => "write";
    public override string Description =>
        "将内容写入文件（整体覆盖，自动创建父目录）。修改已有文件请优先用 edit 做精确替换。";
    public override JsonObject? Parameters => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["file_path"] = new JsonObject { ["type"] = "string", ["description"] = "目标文件路径" },
            ["content"] = new JsonObject { ["type"] = "string", ["description"] = "完整文件内容" },
        },
        ["required"] = new JsonArray("file_path", "content"),
    };
    public override bool NeedsPermission => true;

    public override string Preview(JsonObject args)
    {
        var file = JsonUtil.Str(args["file_path"]) ?? "";
        var outside = PathGuard.Resolve(file).Outside;
        var flag = outside ? "\n⚠ 注意：该路径在当前工作目录之外！" : "";
        return $"写入 {file}{flag}\n{Ui.Ellipsis(JsonUtil.Str(args["content"]) ?? "", 4000)}";
    }

    public override async Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken)
    {
        var file = JsonUtil.Str(args["file_path"]) ?? "";
        if (file.Length == 0) return "错误：缺少 file_path";
        if (args["content"] is null || args["content"]!.GetValueKind() == JsonValueKind.Null)
            return "错误：缺少 content";
        var content = JsonUtil.Str(args["content"]) ?? "";
        var abs = PathGuard.Resolve(file).Abs;
        Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
        await File.WriteAllTextAsync(abs, content, Ui.Utf8NoBom, cancellationToken);
        return $"已写入 {file}（{content.Length} 字符 / {content.Split('\n').Length} 行）";
    }
}
