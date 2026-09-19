using System.Text;
using ccode.core;
using ccode.kernel;

namespace ccode.shell;

/// <summary>行事件：Text=null 且非 Eof 表示 Ctrl+C 打断（空闲=退出、确认中=拒绝）。</summary>
public readonly record struct LineEvent(string? Text, bool Eof);

/// <summary>
/// 终端行源：后台线程阻塞读 stdin，把行转成可等待事件；
/// Ctrl+C 路由通过 Interrupt() 给当前等待者注入"打断"事件——这是三态语义的枢纽。
/// 同一时刻只有一个消费者：REPL 主循环（空闲）或权限确认（轮中）。
/// </summary>
public sealed class LineSource
{
    private readonly object _lock = new();
    private readonly Queue<LineEvent> _pending = new();
    private TaskCompletionSource<LineEvent>? _waiter;

    public Task<LineEvent> WaitAsync()
    {
        lock (_lock)
        {
            if (_pending.Count > 0) return Task.FromResult(_pending.Dequeue());
            var waiter = new TaskCompletionSource<LineEvent>(TaskCreationOptions.RunContinuationsAsynchronously);
            _waiter = waiter;
            return waiter.Task;
        }
    }

    /// <summary>读行线程投递一行。</summary>
    public void Push(string line) => Complete(new LineEvent(line, Eof: false));

    /// <summary>stdin 关闭。</summary>
    public void PushEof() => Complete(new LineEvent(null, Eof: true));

    /// <summary>Ctrl+C 路由：给当前等待者（若有）注入打断事件。</summary>
    public void Interrupt() => Complete(new LineEvent(null, Eof: false));

    private void Complete(LineEvent ev)
    {
        lock (_lock)
        {
            if (_waiter is { } waiter)
            {
                _waiter = null;
                waiter.TrySetResult(ev);
            }
            else
            {
                _pending.Enqueue(ev);
            }
        }
    }
}

/// <summary>
/// REPL 壳插件：读入 → 命令查表分发 → runUserTurn → 打印。命令本体都是插件，壳只管路由。
/// 可取消性三态（本实现的中心考点）：
///   回答流式中 Ctrl+C = 真正取消 HTTP 请求（取消令牌贯穿到流读循环）→ 断尾修复 → 回到提示符，进程不死；
///   权限确认中 Ctrl+C = 拒绝本次；
///   空闲 Ctrl+C = 退出。
/// </summary>
public sealed class ReplShell : ShellPlugin
{
    public override string Name => "repl";

    public override async Task StartAsync(App app)
    {
        var lines = new LineSource();

        // 后台线程阻塞读 stdin（管道/终端通用），行事件进队列
        _ = Task.Run(() =>
        {
            try
            {
                using var stdin = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
                while (stdin.ReadLine() is { } line) lines.Push(line);
                lines.PushEof();
            }
            catch
            {
                lines.PushEof();
            }
        });

        // Ctrl+C 三态路由：e.Cancel=true 阻止默认退出，按当前状态分流——进程不死
        CancellationTokenSource? turnCts = null;
        var askActive = false;
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            if (askActive)
            {
                lines.Interrupt(); // 权限确认中 → 拒绝本次
            }
            else if (turnCts is { } active)
            {
                try { active.Cancel(); } // 回答流式中 → 真正取消 HTTP 请求
                catch (ObjectDisposedException) { /* 轮刚结束，无需取消 */ }
            }
            else
            {
                lines.Interrupt(); // 空闲 → 退出 REPL
            }
        };

        // 权限 UI 适配：把"打印预览 + 问 y/n/a"接进统一闸门；确认中 Ctrl+C = 打断 = deny
        var gate = PermissionGate.Create(
            new ReplPermissionUi(lines, value => askActive = value), app.Yolo);

        var banner = new List<string>
        {
            $"{Ui.Bold("ccode")} v{AppVersion.Version} {Ui.Dim($"· {app.Config.Model} · {Directory.GetCurrentDirectory()}")}",
        };
        if (app.Yolo.Value) banner.Add(Ui.Yellow("当前 --yolo：所有操作免确认"));
        banner.Add(Ui.Dim("输入 /help 查看命令，/exit 退出"));
        Console.WriteLine(string.Join("\n", banner));

        while (true)
        {
            Console.Write(Ui.Cyan("ccode❯ "));
            var ev = await lines.WaitAsync();
            if (ev.Eof) break;         // stdin 关闭
            if (ev.Text is null) break; // 空闲时被 Ctrl+C 打断 = 退出
            var line = ev.Text.Trim();
            if (line.Length == 0) continue;

            if (line.StartsWith('/'))
            {
                var fields = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                var commandName = fields[0].TrimStart('/');
                var command = app.Registry.Commands().FirstOrDefault(c => c.Name == commandName);
                if (command is null)
                {
                    Console.WriteLine(Ui.Yellow($"未知命令 {fields[0]}，/help 查看可用命令。"));
                    continue;
                }
                var outcome = await command.RunAsync(app, fields.Skip(1).ToArray());
                if (outcome.Exit) break;
                continue;
            }

            turnCts = new CancellationTokenSource();
            // @文件引用展开（v0.4-2，与 exec 壳共用同一纯函数）
            line = AtRefs.ExpandAtRefs(line, AtRefs.CappedRead);
            try
            {
                await Turn.RunUserTurnAsync(app, line, new TurnHooks
                {
                    Check = gate,
                    Emit = Render,
                }, turnCts.Token);
                Console.Out.Write("\n");
            }
            catch (OperationCanceledException)
            {
                Console.WriteLine(Ui.Yellow("\n（本轮已中止，上下文保留到上一个完整回答）"));
            }
            catch (Exception e)
            {
                Console.WriteLine(Ui.Red($"出错了：{e.Message}"));
            }
            finally
            {
                turnCts.Dispose();
                turnCts = null;
            }
        }
    }

    /// <summary>
    /// 终端渲染器：AgentEvent → 直接写终端（壳只订阅事件，不拼装；无状态）。
    /// turn_start/user/turn_end/compact 的展示由横幅、提示符与 /compact 命令承担。
    /// </summary>
    private static void Render(AgentEvent ev)
    {
        switch (ev)
        {
            case AgentEvent.TextDelta delta:
                Console.Out.Write(delta.Delta);
                break;
            case AgentEvent.ToolCall call:
                Console.WriteLine($"\n{Ui.Cyan($"⚙ {call.Name}")} {Ui.Dim(Ui.Ellipsis(call.Args.ToJsonString(), 120))}");
                break;
            case AgentEvent.ToolResult result:
                Console.WriteLine(Ui.Dim($"  ↳ {Ui.Ellipsis(result.Summary, 100)} ({result.Ms}ms)"));
                break;
            case AgentEvent.Trimmed trimmed:
                Console.WriteLine(Ui.Dim($"（上下文超预算，已省略 {trimmed.Count} 条早期工具输出）"));
                break;
        }
    }
}

/// <summary>权限确认 UI：打印预览 + 循环问 y/n/a；Ctrl+C 打断（Text=null）= deny。</summary>
internal sealed class ReplPermissionUi(LineSource lines, Action<bool> setAskActive) : IPermissionIO
{
    public async Task<PermissionDecision> AskAsync(PermissionRequest request)
    {
        setAskActive(true);
        try
        {
            Console.WriteLine($"\n{Ui.Yellow($"── {request.Tool} 请求执行 ──")}\n{Ui.Dim(request.Preview)}");
            while (true)
            {
                Console.Write(Ui.Bold("允许? [y=允许 / n=拒绝 / a=本会话全部允许] "));
                var ev = await lines.WaitAsync();
                if (ev.Text is null) return PermissionDecision.Deny; // Ctrl+C 或 stdin 关闭 = 拒绝本次
                var answer = ev.Text.Trim().ToLowerInvariant();
                if (answer == "y") return PermissionDecision.Allow;
                if (answer == "a")
                {
                    Console.WriteLine(Ui.Yellow("本会话后续操作不再逐次确认（可用 /yolo 切回）。"));
                    return PermissionDecision.Always;
                }
                if (answer is "n" or "") return PermissionDecision.Deny;
                Console.WriteLine(Ui.Dim("请回答 y / n / a"));
            }
        }
        finally
        {
            setAskActive(false);
        }
    }
}
