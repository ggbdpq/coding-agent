using ccode.kernel;

namespace ccode.plugins.commands;

/// <summary>
/// /approval：查看或修改审批策略（R4）。normal=写类逐次确认（默认）；never=全部免确认。
/// 运行时改 Config.Approval 并同步本会话的免确认开关（与 --yolo、权限确认里的 a 改的是同一个开关）。
/// </summary>
public sealed class ApprovalCommand : CommandPlugin
{
    public override string Name => "approval";
    public override string Usage => "/approval [normal|never]";
    public override string Summary => "查看或修改审批策略（normal=逐次确认，never=全部免确认）";

    public override Task<CommandOutcome> RunAsync(App app, string[] args)
    {
        if (args.Length > 0)
        {
            var requested = args[0].ToLowerInvariant();
            if (requested is not ("normal" or "never"))
            {
                Console.WriteLine(Ui.Yellow($"审批策略只能是 normal 或 never，收到：{args[0]}"));
                return Task.FromResult(CommandOutcome.None);
            }
            app.Config.Approval = requested;
            // 策略改动立即作用于权限闸门：never 等价开 yolo，normal 恢复逐次确认
            app.Yolo.Value = requested == "never";
        }
        Console.WriteLine(
            $"当前审批策略：{app.Config.Approval}（normal=写类逐次确认，never=全部免确认）；" +
            $"本会话免确认：{(app.Yolo.Value ? "开" : "关")}。");
        return Task.FromResult(CommandOutcome.None);
    }
}
