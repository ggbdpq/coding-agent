using ccode.core;
using ccode.kernel;

namespace ccode.plugins.commands;

/// <summary>/compact：手动触发上下文摘要压缩（自动触发见 core/Turn.cs 的超限治理）。</summary>
public sealed class CompactCommand : CommandPlugin
{
    public override string Name => "compact";
    public override string Usage => "/compact";
    public override string Summary => "把当前对话压缩成摘要，释放上下文预算";

    public override async Task<CommandOutcome> RunAsync(App app, string[] args)
    {
        try
        {
            var savedTokens = await Compact.CompactContextAsync(app);
            Console.WriteLine($"已压缩：替换为任务摘要，节省约 {savedTokens} tokens 的上下文预算。");
        }
        catch (Exception e)
        {
            // 压缩是锦上添花：失败（含对话太短）只提示，不上抛——历史原封不动
            Console.WriteLine($"压缩未执行：{e.Message}");
        }
        return CommandOutcome.None;
    }
}
