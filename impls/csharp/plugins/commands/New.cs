using ccode.kernel;

namespace ccode.plugins.commands;

/// <summary>/new：开新会话——messages 换新 system 数组并换新会话文件。</summary>
public sealed class NewCommand : CommandPlugin
{
    public override string Name => "new";
    public override string Usage => "/new";
    public override string Summary => "开新会话（清空上下文）";

    public override Task<CommandOutcome> RunAsync(App app, string[] args)
    {
        app.ResetMessages();
        app.StartSession();
        Console.WriteLine(Ui.Green("已开新会话，上下文已清空。"));
        return Task.FromResult(CommandOutcome.None);
    }
}
