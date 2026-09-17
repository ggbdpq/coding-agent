using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.plugins.tools;

/// <summary>grep 工具：按正则搜文件内容（ripgrep，尊重 .gitignore）。一工具一文件。</summary>
public sealed class GrepTool : ToolPlugin
{
    public override string Name => "grep";
    public override string Description =>
        "按正则搜文件内容（ripgrep 语法，智能大小写），返回 行号:内容";
    public override JsonObject? Parameters => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["pattern"] = new JsonObject { ["type"] = "string", ["description"] = "正则表达式" },
            ["path"] = new JsonObject { ["type"] = "string", ["description"] = "限定搜索的目录或文件，默认当前目录" },
            ["include"] = new JsonObject { ["type"] = "string", ["description"] = "文件名 glob 过滤，如 \"*.ts\"" },
        },
        ["required"] = new JsonArray("pattern"),
    };
    public override bool NeedsPermission => false;
    public override string Preview(JsonObject args) => $"grep {JsonUtil.Str(args["pattern"]) ?? ""}";

    public override async Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken)
    {
        var pattern = JsonUtil.Str(args["pattern"]) ?? "";
        if (pattern.Length == 0) return "错误：缺少 pattern";
        var rgArgs = new List<string> { "-n", "-S" };
        var include = JsonUtil.Str(args["include"]);
        if (!string.IsNullOrEmpty(include)) rgArgs.AddRange(["-g", include]);
        rgArgs.Add("--");
        rgArgs.Add(pattern);
        rgArgs.Add(JsonUtil.Str(args["path"]) ?? ".");
        return await Rg.RunAsync(rgArgs);
    }
}
