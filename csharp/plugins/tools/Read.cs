using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.plugins.tools;

/// <summary>read 工具：带行号读文件，支持 offset/limit 分段；超大文件拒读并提示分段。
/// 路径先过守卫统一解析（读操作免确认，但解析规则与写类保持一致）。</summary>
public sealed class ReadTool : ToolPlugin
{
    private const long MaxBytes = 1024 * 1024;
    private const int DefaultLimit = 2000;

    public override string Name => "read";
    public override string Description =>
        "读取文件内容，带行号（1-based）。大文件可用 offset（起始行）和 limit（最多行数）分段读取。";
    public override JsonObject? Parameters => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["file_path"] = new JsonObject { ["type"] = "string", ["description"] = "文件路径，相对当前目录或绝对路径" },
            ["offset"] = new JsonObject { ["type"] = "number", ["description"] = "起始行号（1-based），默认 1" },
            ["limit"] = new JsonObject { ["type"] = "number", ["description"] = $"最多读取行数，默认 {DefaultLimit}" },
        },
        ["required"] = new JsonArray("file_path"),
    };
    public override bool NeedsPermission => false;
    public override string Preview(JsonObject args) => $"read {JsonUtil.Str(args["file_path"]) ?? ""}";

    public override Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken)
    {
        var file = JsonUtil.Str(args["file_path"]) ?? "";
        if (file.Length == 0) return Task.FromResult("错误：缺少 file_path");
        var resolved = PathGuard.Resolve(file);
        var info = new FileInfo(resolved.Abs);
        if (!info.Exists)
        {
            if (Directory.Exists(resolved.Abs)) return Task.FromResult($"错误：{file} 是目录，请用 glob 列文件");
            return Task.FromResult($"错误：文件不存在：{file}");
        }
        if (info.Length > MaxBytes)
            return Task.FromResult(
                $"错误：文件过大（{info.Length} 字节，上限 {MaxBytes}），请用 offset/limit 分段读取");

        var text = File.ReadAllText(resolved.Abs);
        var lines = text.Split('\n');
        var total = lines.Length;
        var offset = JsonUtil.Int(args["offset"], 1);
        var start = Math.Max(0, Math.Min(offset - 1, total - 1));
        var limit = Math.Max(1, JsonUtil.Int(args["limit"], DefaultLimit));
        var count = Math.Min(limit, total - start);
        var body = string.Join("\n", Enumerable.Range(start, count)
            .Select(i => $"{(i + 1).ToString().PadLeft(6)}\t{lines[i]}"));
        var note = start + limit < total
            ? $"\n（已显示第 {start + 1}-{Math.Min(start + limit, total)} 行，共 {total} 行；继续读请调大 offset）"
            : "";
        return Task.FromResult(body + note);
    }
}
