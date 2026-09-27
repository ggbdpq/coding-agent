using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.plugins.tools;

/// <summary>todo 工具：会话内任务清单——插件 API 的活样例。
/// 状态存在本插件的静态字段里：进程内存活，/new 不清空、退出即失；
/// 刻意做小，只演示"加一个工具 = 加一个文件 + 清单一行"。</summary>
public sealed class TodoTool : ToolPlugin
{
    private static readonly List<TodoItem> Items = [];
    private static int _nextId = 1;

    private sealed record TodoItem(int Id, string Text, bool Done);

    public override string Name => "todo";
    public override string Description =>
        "维护会话内任务清单（add/list/done/clear），多步任务时用来跟踪进度。";
    public override JsonObject? Parameters => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["action"] = new JsonObject
            {
                ["type"] = "string",
                ["enum"] = new JsonArray("add", "list", "done", "clear"),
                ["description"] = "操作",
            },
            ["text"] = new JsonObject { ["type"] = "string", ["description"] = "add 时的任务内容" },
            ["id"] = new JsonObject { ["type"] = "number", ["description"] = "done 时的任务编号" },
        },
        ["required"] = new JsonArray("action"),
    };
    public override bool NeedsPermission => false;
    public override string Preview(JsonObject args) => $"todo {JsonUtil.Str(args["action"]) ?? ""}";

    public override Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken)
    {
        var action = JsonUtil.Str(args["action"]) ?? "list";
        if (action == "add")
        {
            var text = (JsonUtil.Str(args["text"]) ?? "").Trim();
            if (text.Length == 0) return Task.FromResult("错误：add 需要 text");
            var id = _nextId++;
            Items.Add(new TodoItem(id, text, false));
            return Task.FromResult($"已添加 #{id}：{text}");
        }
        if (action == "done")
        {
            var rawId = args["id"];
            var id = JsonUtil.Int(rawId, 0);
            var index = Items.FindIndex(i => i.Id == id);
            if (index < 0)
                return Task.FromResult($"错误：没有 #{rawId?.ToJsonString() ?? "undefined"} 这条任务");
            Items[index] = Items[index] with { Done = true };
            return Task.FromResult($"已完成 #{Items[index].Id}：{Items[index].Text}");
        }
        if (action == "clear")
        {
            var count = Items.Count;
            Items.Clear();
            return Task.FromResult($"已清空 {count} 条任务");
        }
        if (Items.Count == 0) return Task.FromResult("（清单为空）");
        return Task.FromResult(string.Join("\n",
            Items.Select(i => $"{(i.Done ? "[x]" : "[ ]")} #{i.Id} {i.Text}")));
    }
}
