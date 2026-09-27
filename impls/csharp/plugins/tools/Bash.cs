using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using ccode.kernel;

namespace ccode.plugins.tools;

/// <summary>bash 工具：子进程执行命令，输出封顶、超时强杀、Ctrl+C 可取消。
/// win32 优先用 Git Bash（模型常发 unix 命令），只认显式路径，避免误中 System32 的 WSL bash；
/// 都没有就退回 cmd。安全边界：执行前经权限确认，确认界面展示完整命令。</summary>
public sealed class BashTool : ToolPlugin
{
    private const int MaxOutput = 64 * 1024;
    private const int DefaultTimeoutSec = 120;
    private const int MaxTimeoutSec = 600;

    public override string Name => "bash";
    public override string Description =>
        "在当前目录执行 shell 命令并返回退出码与输出。用于跑测试、构建、git 等验证操作；输出超长会被截断。";
    public override JsonObject? Parameters => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["command"] = new JsonObject { ["type"] = "string", ["description"] = "要执行的命令" },
            ["timeout_sec"] = new JsonObject
            {
                ["type"] = "number",
                ["description"] = $"超时秒数，默认 {DefaultTimeoutSec}，上限 {MaxTimeoutSec}",
            },
        },
        ["required"] = new JsonArray("command"),
    };
    public override bool NeedsPermission => true;
    public override string Preview(JsonObject args) =>
        $"执行命令（cwd={Directory.GetCurrentDirectory()}）\n$ {JsonUtil.Str(args["command"]) ?? ""}";

    public override async Task<string> RunAsync(JsonObject args, CancellationToken cancellationToken)
    {
        var command = JsonUtil.Str(args["command"]) ?? "";
        if (string.IsNullOrWhiteSpace(command)) return "错误：缺少 command";
        var timeoutSec = Math.Max(1, Math.Min(JsonUtil.Int(args["timeout_sec"], DefaultTimeoutSec), MaxTimeoutSec));
        var (file, shellArgs) = ResolveShell();

        using var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = file,
            WorkingDirectory = Directory.GetCurrentDirectory(),
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var arg in shellArgs) process.StartInfo.ArgumentList.Add(arg);
        process.StartInfo.ArgumentList.Add(command);

        try
        {
            process.Start();
        }
        catch (Exception e)
        {
            return $"错误：无法启动 shell（{e.Message}）";
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync(CancellationToken.None);
        var stderrTask = process.StandardError.ReadToEndAsync(CancellationToken.None);

        var timedOut = false;
        using (var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
        {
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(timeoutSec));
            try
            {
                await process.WaitForExitAsync(timeoutCts.Token);
            }
            catch (OperationCanceledException)
            {
                // 超时或用户 Ctrl+C：连坐杀掉进程树
                KillTree(process);
                try
                {
                    await process.WaitForExitAsync(CancellationToken.None)
                        .WaitAsync(TimeSpan.FromSeconds(5));
                }
                catch { /* 已尽力终止 */ }
                if (cancellationToken.IsCancellationRequested)
                {
                    _ = DrainQuietly(stdoutTask);
                    _ = DrainQuietly(stderrTask);
                    throw new OperationCanceledException(cancellationToken); // 用户取消：交给断尾修复
                }
                timedOut = true;
            }
        }

        // 输出读取兜底：极端情况下孙进程占住管道时不挂死
        string stdout, stderr;
        var allRead = Task.WhenAll(stdoutTask, stderrTask);
        var finished = await Task.WhenAny(allRead, Task.Delay(TimeSpan.FromSeconds(3)));
        if (finished == allRead)
        {
            stdout = stdoutTask.Result;
            stderr = stderrTask.Result;
        }
        else
        {
            stdout = "";
            stderr = "";
            try { process.Kill(entireProcessTree: true); }
            catch { /* 已退出 */ }
        }

        static string Cap(string s) => s.Length >= MaxOutput ? s[..MaxOutput] + "\n…（输出超长已截断）" : s;
        var parts = new List<string>
        {
            $"exit={(timedOut ? $"timeout（{timeoutSec}s 超时强制终止）" : process.ExitCode.ToString())}",
        };
        if (stdout.Trim().Length > 0) parts.Add($"--- stdout ---\n{Cap(stdout).TrimEnd()}");
        if (stderr.Trim().Length > 0) parts.Add($"--- stderr ---\n{Cap(stderr).TrimEnd()}");
        return string.Join("\n", parts);
    }

    private static (string File, List<string> Args) ResolveShell()
    {
        if (!OperatingSystem.IsWindows()) return ("/bin/bash", ["-c"]);
        var candidates = new List<string>();
        var envBash = Environment.GetEnvironmentVariable("CCODE_BASH");
        if (!string.IsNullOrEmpty(envBash)) candidates.Add(envBash);
        candidates.Add(@"C:\Program Files\Git\bin\bash.exe");
        foreach (var candidate in candidates)
            if (File.Exists(candidate)) return (candidate, ["-c"]);
        return (Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe", ["/d", "/s", "/c"]);
    }

    /// <summary>Windows 上 Kill 杀不掉子进程树，用 taskkill 连坐。</summary>
    private static void KillTree(Process process)
    {
        try
        {
            if (OperatingSystem.IsWindows() && process.Id > 0)
            {
                using var killer = Process.Start(new ProcessStartInfo("taskkill", $"/pid {process.Id} /T /F")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                });
                killer?.WaitForExit(5000);
            }
            else
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            /* 进程可能已退出 */
        }
    }

    private static async Task DrainQuietly(Task<string> task)
    {
        try { await task; }
        catch { /* 收尾读取，失败不关心 */ }
    }
}
