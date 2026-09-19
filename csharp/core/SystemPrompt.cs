using ccode.kernel;

namespace ccode.core;

/// <summary>
/// 系统提示词：ccode 身份 + 运行环境 + 指令文件注入 + 技能索引。
/// 注入顺序：~/.ccode/AGENTS.md（全局）在前，项目根 AGENTS.md 在后（后者更具体）。
/// Skill 约定：~/.ccode/skills/*.md 与 &lt;cwd&gt;/.ccode/skills/*.md 为技能库，
/// 此处只注入"可用技能索引"，正文由 agent 按需用 read 工具读取——最小机制，无加载器。
/// </summary>
public static class SystemPrompt
{
    public static string Build(string cwd)
    {
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd");
        var os = OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux";
        var parts = new List<string>
        {
            "你是 ccode，一个直接运行在用户本地终端的极简 coding agent。",
            $"当前工作目录：{cwd}",
            $"操作系统：{os}；今天日期：{today}",
            "",
            "工作原则：",
            "- 动手改代码前先 read 相关文件，弄清上下文再动手。",
            "- 修改文件用 edit 做精确替换，old_string 必须带足够上下文保证唯一；新文件才用 write。",
            "- 跨文件多处一致的修改用 apply_patch 原子补丁（先全部预验再写入）。",
            "- 修改后用 bash 运行相关测试或命令验证，如实报告结果，绝不谎报通过。",
            "- 找不到文件时先用 glob/grep 定位，不要瞎猜路径。",
            "- 回答用简体中文，简洁直接。",
        };
        var global = ReadIfExists(Path.Combine(ConfigLoader.HomeDir(), ".ccode", "AGENTS.md"));
        if (global != null) parts.AddRange(["", "# 用户全局指令（~/.ccode/AGENTS.md）", global]);
        var project = ReadIfExists(Path.Combine(cwd, "AGENTS.md"));
        if (project != null) parts.AddRange(["", "# 项目指令（AGENTS.md）", project]);
        var skills = SkillIndex(
        [
            Path.Combine(ConfigLoader.HomeDir(), ".ccode", "skills"),
            Path.Combine(cwd, ".ccode", "skills"),
        ]);
        if (skills != null) parts.AddRange(["", skills]);
        return string.Join("\n", parts);
    }

    /// <summary>技能索引：列出技能目录中每个 .md 的名字与首行说明（无任何条目返回 null）。</summary>
    public static string? SkillIndex(string[] dirs)
    {
        var lines = new List<string>();
        foreach (var rawDir in dirs)
        {
            var dir = Path.GetFullPath(rawDir);
            if (!Directory.Exists(dir)) continue;
            string[] entries;
            try
            {
                entries = Directory.GetFiles(dir, "*.md");
            }
            catch
            {
                continue;
            }
            foreach (var full in entries)
            {
                // 边界自检（规范惯用法）：文件必须位于技能目录之内
                if (!full.StartsWith(dir + Path.DirectorySeparatorChar)) continue;
                var desc = "";
                try
                {
                    var first = File.ReadAllText(full)
                        .Split('\n')
                        .FirstOrDefault(l => l.Trim().Length > 0);
                    desc = first ?? "";
                    // 对齐 tcode 的 replace(/^#+\s*/, '')：去掉前导 # 与其后空白
                    if (desc.StartsWith('#')) desc = desc.TrimStart('#').TrimStart();
                    if (desc.Length > 60) desc = desc[..60];
                }
                catch
                {
                    /* 读不了就只列名字 */
                }
                lines.Add($"- {Path.GetFileName(dir)}/{Path.GetFileName(full)}：{desc}（用 read 工具按需读取全文）");
            }
        }
        return lines.Count > 0
            ? string.Join("\n", new[] { "## 可用技能（按需用 read 读取全文）" }.Concat(lines))
            : null;
    }

    private static string? ReadIfExists(string file)
    {
        try
        {
            return File.Exists(file) ? File.ReadAllText(file).Trim() : null;
        }
        catch
        {
            return null;
        }
    }
}
