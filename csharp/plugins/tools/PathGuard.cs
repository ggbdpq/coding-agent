namespace ccode.plugins.tools;

public sealed record ResolvedPath(string Abs, bool Outside);

/// <summary>
/// 路径守卫：解析模型给的路径，并标注目标是否越出当前工作目录。
/// ccode 的安全边界是权限确认（人工把关），本模块的职责是把越界目标
/// 显式带出来，让确认界面能看到 "../" 或绝对路径这类穿越意图，而不是静默放行。
/// 非插件，是工具共享的普通静态类（不进注册表）。
/// </summary>
public static class PathGuard
{
    public static ResolvedPath Resolve(string input)
    {
        var abs = Path.GetFullPath(input);
        var rel = Path.GetRelativePath(Directory.GetCurrentDirectory(), abs);
        var outside = rel.StartsWith("..") || Path.IsPathRooted(rel);
        return new ResolvedPath(abs, outside);
    }
}
