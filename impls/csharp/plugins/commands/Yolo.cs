using ccode.kernel;

namespace ccode.plugins.commands;

/// <summary>/yolo：切换本会话免确认模式（与 --yolo 启动参数、权限确认里的 a 改的是同一个开关）。</summary>
public sealed class YoloCommand : CommandPlugin
{
    public override string Name => "yolo";
    public override string Usage => "/yolo";
    public override string Summary => "切换本会话免确认模式";

    public override Task<CommandOutcome> RunAsync(App app, string[] args)
    {
        app.Yolo.Value = !app.Yolo.Value;
        Console.WriteLine(app.Yolo.Value
            ? Ui.Yellow("已开启免确认（yolo）。")
            : Ui.Green("已恢复逐次确认。"));
        return Task.FromResult(CommandOutcome.None);
    }
}
