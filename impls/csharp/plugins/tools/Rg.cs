using System.Diagnostics;
using System.Text;

namespace ccode.plugins.tools;

/// <summary>rg 工具函数：glob/grep 两个工具共用。约定退出码：0 有匹配、1 无匹配、≥2 出错。</summary>
public static class Rg
{
    public static async Task<string> RunAsync(IReadOnlyList<string> rgArgs, int cap = 8000)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo("rg")
            {
                WorkingDirectory = Directory.GetCurrentDirectory(),
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            },
        };
        foreach (var arg in rgArgs) process.StartInfo.ArgumentList.Add(arg);
        try
        {
            process.Start();
        }
        catch (Exception e)
        {
            return $"错误：无法启动 rg（{e.Message}）。本工具依赖 ripgrep，请先安装。";
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync(CancellationToken.None);
        var stderrTask = process.StandardError.ReadToEndAsync(CancellationToken.None);
        await process.WaitForExitAsync(CancellationToken.None);
        var code = process.ExitCode;
        string stdout, stderr;
        try
        {
            stdout = await stdoutTask;
            stderr = await stderrTask;
        }
        catch
        {
            stdout = "";
            stderr = "";
        }

        if (code == 1 && stderr.Trim().Length == 0) return "无匹配";
        if (code > 1)
        {
            var brief = stderr.Trim();
            return $"错误：rg 退出码 {code}：{brief[..Math.Min(500, brief.Length)]}";
        }
        var result = stdout;
        if (result.Length > cap) result = result[..cap] + "\n…（结果超长已截断）";
        var trimmed = result.TrimEnd();
        return trimmed.Length > 0 ? trimmed : "无匹配";
    }
}
