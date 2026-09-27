using ccode.kernel;

namespace ccode.plugins.commands;

/// <summary>/help：从注册表生成命令列表——新命令插件自动出现在帮助里。</summary>
public sealed class HelpCommand : CommandPlugin
{
    public override string Name => "help";
    public override string Usage => "/help";
    public override string Summary => "显示本帮助";

    public override Task<CommandOutcome> RunAsync(App app, string[] args)
    {
        Console.WriteLine(HelpText(app));
        return Task.FromResult(CommandOutcome.None);
    }

    internal static string HelpText(App app)
    {
        var lines = new List<string> { "命令：" };
        lines.AddRange(app.Registry.Commands().Select(cmd => $"  {cmd.Usage.PadRight(15)}{cmd.Summary}"));
        lines.Add("其他输入直接作为对话发给模型。");
        lines.Add("Ctrl+C：回答流式中=中止本轮；权限确认中=拒绝本次。");
        return string.Join("\n", lines);
    }
}
