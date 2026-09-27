using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.plugins.tools;

/// <summary>
/// apply_patch 工具：多文件原子编辑——先对全部编辑做预验（每条 old_string 必须在其
/// 文件中唯一存在），任一失败则整体不应用并逐条报告；全部通过后才写入。
/// 原子性说明：预验与写入之间无并发写者（ccode 工具循环串行），因此"全预验→全写入"
/// 即实际原子；安全边界：逐次确认，preview 列出全部目标文件。
/// 与 tcode 一致：不 override SkipPermission（白名单不豁免它，默认恒 false）。
/// </summary>
public sealed class ApplyPatchTool : ToolPlugin
{
    /// <summary>一条预验通过、待写入的编辑。</summary>
    private sealed record PreparedEdit(string Abs, string Display, string Original, string Next);

    public override string Name => "apply_patch";

    public override string Description =>
        "对多个文件一次应用多处精确替换（原子操作：全部预验通过才写入，任一失败整体放弃）。" +
        "适合跨文件的重命名/批量调整；单文件小改动仍优先用 edit。";

    public override JsonObject? Parameters => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["edits"] = new JsonObject
            {
                ["type"] = "array",
                ["description"] = "编辑列表，每项 {file_path, old_string, new_string, replace_all?}",
                ["items"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new JsonObject
                    {
                        ["file_path"] = new JsonObject { ["type"] = "string" },
                        ["old_string"] = new JsonObject { ["type"] = "string" },
                        ["new_string"] = new JsonObject { ["type"] = "string" },
                        ["replace_all"] = new JsonObject { ["type"] = "boolean" },
                    },
                    ["required"] = new JsonArray("file_path", "old_string", "new_string"),
                },
            },
        },
        ["required"] = new JsonArray("edits"),
    };

    public override bool NeedsPermission => true;

    public override string Preview(JsonObject args)
    {
        // edits 非数组按 [] 处理；去重保持首次出现顺序
        var edits = args["edits"] as JsonArray ?? [];
        var files = new List<string>();
        foreach (var edit in edits.OfType<JsonObject>())
        {
            var file = JsonUtil.Str(edit["file_path"]) ?? "";
            if (!files.Contains(file)) files.Add(file);
        }
        return $"原子补丁：{edits.Count} 处编辑，涉及 {files.Count} 个文件\n" +
               string.Join("\n", files.Select(f => $"  · {f}"));
    }

    public override async Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken)
    {
        var raw = args["edits"] as JsonArray ?? [];
        if (raw.Count == 0) return "错误：edits 不能为空";

        // 第一阶段：全量预验（读文件 + 唯一性检查），不改任何磁盘内容。
        // 缓存按展示路径键控：同文件只读一次，多条编辑的 next 都基于同一份缓存原文
        var cache = new Dictionary<string, string>();
        var prepared = new List<PreparedEdit>();
        var errors = new List<string>();
        for (var i = 0; i < raw.Count; i++)
        {
            var edit = raw[i] as JsonObject;
            var file = JsonUtil.Str(edit?["file_path"]) ?? "";
            var oldString = JsonUtil.Str(edit?["old_string"]) ?? "";
            var newString = JsonUtil.Str(edit?["new_string"]) ?? "";
            var replaceAll = JsonUtil.Bool(edit?["replace_all"]);
            if (file.Length == 0 || oldString.Length == 0)
            {
                errors.Add($"#{i}：缺少 file_path 或 old_string");
                continue;
            }
            var abs = PathGuard.Resolve(file).Abs;
            if (!cache.TryGetValue(file, out var original))
            {
                try
                {
                    original = await File.ReadAllTextAsync(abs, cancellationToken);
                }
                catch
                {
                    errors.Add($"#{i}：无法读取 {file}");
                    continue;
                }
                cache[file] = original;
            }
            var count = EditTool.CountOccurrences(original, oldString);
            if (count == 0)
            {
                errors.Add($"#{i}：{file} 中未找到 old_string");
            }
            else if (count > 1 && !replaceAll)
            {
                errors.Add($"#{i}：{file} 中 old_string 出现 {count} 次（需 replace_all 或更多上下文）");
                continue;
            }
            var next = replaceAll && count > 1
                ? original.Replace(oldString, newString)
                : EditTool.ReplaceFirst(original, oldString, newString);
            prepared.Add(new PreparedEdit(abs, file, original, next));
        }
        if (errors.Count > 0)
            return "错误：预验未通过，未写入任何文件。\n" + string.Join("\n", errors.Select(s => $"- {s}"));

        // 第二阶段：全部通过，按 prepared 顺序逐条写入。
        // 同一文件多条编辑时各 next 都基于同一份缓存原文、后写覆盖前写（与 tcode 一致）
        foreach (var p in prepared)
            await File.WriteAllTextAsync(p.Abs, p.Next, Ui.Utf8NoBom, cancellationToken);
        return $"已应用补丁：{prepared.Count} 处编辑，涉及 {prepared.Select(p => p.Display).Distinct().Count()} 个文件";
    }
}
