using ccode.kernel;

namespace ccode.core;

public enum PermissionDecision
{
    Allow,
    Deny,
    Always,
}

public sealed record PermissionRequest(string Tool, string Preview);

/// <summary>壳提供 ask 的 UI 适配，返回三态决定（allow/deny/always）。</summary>
public interface IPermissionIO
{
    Task<PermissionDecision> AskAsync(PermissionRequest request);
}

/// <summary>
/// 权限闸门：write/edit/bash 等写类操作逐次确认；--yolo / 回答"本会话全部允许"放行整个会话。
/// 这是 ccode 的核心安全边界。闸门语义全项目只有这一份：
/// 壳（REPL）只提供 ask 的 UI 适配，返回 allow/deny/always 三态决定。
/// 按分层规则留在 core：安全边界不开放替换，也不进插件注册表。
/// </summary>
public static class PermissionGate
{
    public static Func<string, string, Task<bool>> Create(IPermissionIO io, YoloRef yolo) =>
        async (toolName, preview) =>
        {
            if (yolo.Value) return true;
            var decision = await io.AskAsync(new PermissionRequest(toolName, preview));
            if (decision == PermissionDecision.Always) yolo.Value = true;
            return decision != PermissionDecision.Deny;
        };
}
