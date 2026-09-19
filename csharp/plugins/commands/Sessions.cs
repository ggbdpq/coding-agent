using ccode.kernel;

namespace ccode.plugins.commands;

/// <summary>/sessions：列出最近会话（/resume 无编号的列表视图；加载仍用 /resume &lt;编号&gt;）。</summary>
public sealed class SessionsCommand : CommandPlugin
{
    public override string Name => "sessions";
    public override string Usage => "/sessions";
    public override string Summary => "列出最近会话（用 /resume <编号> 加载）";

    public override Task<CommandOutcome> RunAsync(App app, string[] args)
    {
        var list = app.Store.ListRecent(5);
        if (list.Count == 0)
        {
            Console.WriteLine(Ui.Yellow("暂无历史会话。"));
            return Task.FromResult(CommandOutcome.None);
        }
        Console.WriteLine("最近的会话：");
        for (var i = 0; i < list.Count; i++)
        {
            var time = DateTimeOffset
                .FromUnixTimeMilliseconds(list[i].MtimeMs)
                .LocalDateTime.ToString("yyyy/MM/dd HH:mm:ss");
            Console.WriteLine($"  {i + 1}. {Ui.Dim(time)} {list[i].Label}");
        }
        return Task.FromResult(CommandOutcome.None);
    }
}
