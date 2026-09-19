using ccode.kernel;

namespace ccode.plugins.commands;

/// <summary>
/// /plan：切换 Plan Mode（只读规划）。开启时写类工具在 agentloop 被拒，
/// 引导模型只读探索并产出计划；关闭后恢复正常执行。
/// 系统提示词的 Plan Mode 分节由本命令直接维护在 Messages[0] 上。
/// </summary>
public sealed class PlanCommand : CommandPlugin
{
    /// <summary>注入到 system 消息尾部的分节（以空行开头，与 tcode 逐字一致）。</summary>
    private const string PlanSection =
        "\n# Plan Mode（当前生效）\n当前为只读规划阶段：禁止 write/edit/bash/web_fetch 等写类操作。\n" +
        "请用 read/glob/grep 只读探索，并用 todo 工具把分步计划记录下来；\n" +
        "计划完成后明确告知用户：切换回普通模式（/plan）执行。";

    public override string Name => "plan";
    public override string Usage => "/plan";
    public override string Summary => "切换 Plan Mode（只读规划 ↔ 普通执行）";

    public override Task<CommandOutcome> RunAsync(App app, string[] args)
    {
        app.PlanMode.Value = !app.PlanMode.Value;
        var sys = app.Messages[0];
        if (app.PlanMode.Value)
        {
            if (sys.Content?.Contains("# Plan Mode") != true)
                sys.Content = (sys.Content ?? "") + PlanSection;
            Console.WriteLine(Ui.Yellow("已进入 Plan Mode：只读探索与规划，写类工具将被拒绝。"));
        }
        else
        {
            if (sys.Content != null)
                sys.Content = sys.Content.Split("\n# Plan Mode（当前生效）")[0];
            Console.WriteLine(Ui.Green("已退出 Plan Mode，恢复正常执行。"));
        }
        return Task.FromResult(CommandOutcome.None);
    }
}
