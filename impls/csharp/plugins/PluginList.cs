using ccode.kernel;
using ccode.plugins.commands;
using ccode.plugins.tools;
using ccode.providers;
using ccode.shell;

namespace ccode.plugins;

/// <summary>
/// 内置插件清单：加插件 = 加文件 + 在这里挂一行。
/// 显式组合而非目录扫描——装配顺序可读、可预测。
/// 注意 openai provider 必须排在 provider 类的最后（Matches 恒真，是兜底）。
/// </summary>
public static class PluginList
{
    public static Registry Build() => new Registry()
        // —— 工具 ——
        .Register(new ReadTool())
        .Register(new WriteTool())
        .Register(new EditTool())
        .Register(new BashTool())
        .Register(new GlobTool())
        .Register(new GrepTool())
        .Register(new TodoTool())
        .Register(new WebFetchTool())
        .Register(new ApplyPatchTool())
        // —— 命令（/help 列表按这里的顺序展示） ——
        .Register(new HelpCommand())
        .Register(new NewCommand())
        .Register(new ResumeCommand())
        .Register(new SessionsCommand())
        .Register(new YoloCommand())
        .Register(new ApprovalCommand())
        .Register(new PlanCommand())
        .Register(new CompactCommand())
        .Register(new InitCommand())
        .Register(new ExitCommand())
        // —— 协议（anthropic 在前按 URL 命中，openai 恒真兜底必须在后） ——
        .Register(new AnthropicPlugin())
        .Register(new OpenAiPlugin())
        // —— 壳 ——
        .Register(new ReplShell());
}
