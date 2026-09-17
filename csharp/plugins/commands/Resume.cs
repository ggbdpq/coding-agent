using System.Globalization;
using ccode.kernel;

namespace ccode.plugins.commands;

/// <summary>/resume：恢复历史会话。无编号=列最近 5 个；编号=加载并换新会话文件继续写。</summary>
public sealed class ResumeCommand : CommandPlugin
{
    public override string Name => "resume";
    public override string Usage => "/resume [编号]";
    public override string Summary => "恢复历史会话（无编号=列最近 5 个）";

    public override Task<CommandOutcome> RunAsync(App app, string[] args)
    {
        var list = app.Store.ListRecent(5);
        if (list.Count == 0)
        {
            Console.WriteLine(Ui.Yellow("暂无可恢复的历史会话。"));
            return Task.FromResult(CommandOutcome.None);
        }

        double number = 0;
        var parsed = args.Length > 0 &&
                     double.TryParse(args[0], CultureInfo.InvariantCulture, out number);
        var valid = parsed && number == Math.Floor(number) && number >= 1 && number <= list.Count;
        if (!valid)
        {
            Console.WriteLine("最近的会话：");
            for (var i = 0; i < list.Count; i++)
            {
                var time = DateTimeOffset
                    .FromUnixTimeMilliseconds(list[i].MtimeMs)
                    .LocalDateTime.ToString("yyyy/MM/dd HH:mm:ss");
                Console.WriteLine($"  {i + 1}. {Ui.Dim(time)} {list[i].Label}");
            }
            Console.WriteLine(Ui.Yellow(parsed ? $"编号无效（1-{list.Count}）" : "用 /resume <编号> 加载"));
            return Task.FromResult(CommandOutcome.None);
        }

        var picked = list[(int)number - 1];
        var loaded = app.Store.Load(picked.File).Where(m => m.Role != "system").ToList();
        app.ResetMessages();
        app.Messages.AddRange(loaded);
        app.StartSession(new Dictionary<string, object?> { ["resumedFrom"] = Path.GetFileName(picked.File) });
        Console.WriteLine(Ui.Green($"已恢复 {loaded.Count} 条消息，后续写入新会话文件。"));
        return Task.FromResult(CommandOutcome.None);
    }
}
