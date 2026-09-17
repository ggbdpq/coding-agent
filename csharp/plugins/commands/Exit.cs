using ccode.kernel;

namespace ccode.plugins.commands;

/// <summary>/exit：返回 exit 信号，由壳（repl）负责收尾退出。</summary>
public sealed class ExitCommand : CommandPlugin
{
    public override string Name => "exit";
    public override string Usage => "/exit";
    public override string Summary => "退出（Ctrl+C 亦可）";

    public override Task<CommandOutcome> RunAsync(App app, string[] args) =>
        Task.FromResult(CommandOutcome.ExitNow);
}
