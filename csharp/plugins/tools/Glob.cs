using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.plugins.tools;

/// <summary>glob 工具：按 glob 模式列文件（ripgrep，尊重 .gitignore）。一工具一文件。</summary>
public sealed class GlobTool : ToolPlugin
{
    public override string Name => "glob";
    public override string Description =>
        "按 glob 模式列文件（尊重 .gitignore），如 \"*.ts\"、\"src/**/*.test.ts\"";
    public override JsonObject? Parameters => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["pattern"] = new JsonObject { ["type"] = "string", ["description"] = "glob 模式" },
        },
        ["required"] = new JsonArray("pattern"),
    };
    public override bool NeedsPermission => false;
    public override string Preview(JsonObject args) => $"glob {JsonUtil.Str(args["pattern"]) ?? ""}";

    public override async Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken)
    {
        var pattern = JsonUtil.Str(args["pattern"]) ?? "";
        if (pattern.Length == 0) return "错误：缺少 pattern";
        return await Rg.RunAsync(["--files", "-g", pattern]);
    }
}
