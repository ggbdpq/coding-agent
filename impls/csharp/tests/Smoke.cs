using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace ccode.tests;

/// <summary>
/// 端到端冒烟（无网络）：TcpListener 手写假 SSE 服务器按剧本回包（不用 HttpListener——它要 netsh URLACL）；
/// 被测对象是 dotnet build 出的 ccode 子进程（HOME/USERPROFILE 隔离到临时目录，env 设 CCODE_*）。
/// 场景对齐 tcode/test/smoke.mjs 的 A/B/C/D 区段，F 场景为 REPL 版权限确认：stdin 喂 y/n 断言 allow/deny 两轮。
/// </summary>
internal static class Smoke
{
    private static readonly object Lock = new();
    private static readonly List<string> Bodies = [];

    private static TcpListener? _listener;
    private static string _serverUrl = "";
    private static string _exePath = "";
    private static string _dllPath = "";
    private static string _dotnetDir = "";
    private static string? _homeA;

    public static void All()
    {
        LocateBuildOutput();
        StartServer();
        Runner.Case("冒烟A：--yolo 工具闭环全链路", ScenarioA);
        Runner.Case("冒烟B：/resume 恢复并携带历史", () => ScenarioB(_homeA!));
        Runner.Case("冒烟C：Anthropic 协议（分片 input_json_delta）", ScenarioC);
        Runner.Case("冒烟D：web_fetch SSRF 拦截且回流", ScenarioD);
        Runner.Case("冒烟F：无 --yolo 权限 allow/deny 两轮", ScenarioF);
        Runner.Case("冒烟H：exec --yolo 无交互单任务", ScenarioH);
    }

    // ---------- 假 SSE 服务器 ----------

    private static void LocateBuildOutput()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "ccode.csproj")))
            dir = dir.Parent;
        if (dir is null)
            throw new Exception("冒烟：从测试输出目录向上找不到 ccode.csproj");
        var root = dir.FullName;
        _exePath = Path.Combine(root, "bin", "Debug", "net8.0", "ccode.exe");
        _dllPath = Path.Combine(root, "bin", "Debug", "net8.0", "ccode.dll");
        _dotnetDir = Path.GetDirectoryName(Environment.ProcessPath) ?? "";
        if (!File.Exists(_exePath) && !File.Exists(_dllPath))
            throw new Exception("冒烟：找不到 ccode 构建产物（bin/Debug/net8.0），请先构建主项目");
    }

    private static void StartServer()
    {
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        var port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _serverUrl = $"http://127.0.0.1:{port}/v1";
        _ = Task.Run(async () =>
        {
            while (true)
            {
                TcpClient client;
                try { client = await _listener.AcceptTcpClientAsync(); }
                catch { break; }
                _ = Task.Run(() => HandleClientAsync(client));
            }
        });
    }

    private static async Task HandleClientAsync(TcpClient client)
    {
        try
        {
            using (client)
            {
                var stream = client.GetStream();
                var requestLine = await ReadHeaderLineAsync(stream);
                var contentLength = 0;
                while (true)
                {
                    var header = await ReadHeaderLineAsync(stream);
                    if (header.Length == 0) break;
                    var sep = header.IndexOf(':');
                    if (sep > 0 && header[..sep].Trim()
                            .Equals("Content-Length", StringComparison.OrdinalIgnoreCase) &&
                        int.TryParse(header[(sep + 1)..].Trim(), out var length))
                        contentLength = length;
                }
                var bodyBytes = new byte[contentLength];
                var read = 0;
                while (read < contentLength)
                {
                    var n = await stream.ReadAsync(bodyBytes.AsMemory(read, contentLength - read));
                    if (n <= 0) break;
                    read += n;
                }
                var body = Encoding.UTF8.GetString(bodyBytes, 0, read);
                lock (Lock) Bodies.Add(body);

                var path = requestLine.Split(' ').ElementAtOrDefault(1) ?? "/";
                var payload = Encoding.UTF8.GetBytes(BuildScript(path, body));
                var head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n" +
                           $"Content-Length: {payload.Length}\r\nConnection: close\r\n\r\n";
                await stream.WriteAsync(Encoding.UTF8.GetBytes(head));
                await stream.WriteAsync(payload);
                await stream.FlushAsync();
            }
        }
        catch
        {
            /* 连接级失败忽略 */
        }
    }

    private static async Task<string> ReadHeaderLineAsync(NetworkStream stream)
    {
        var buffer = new List<byte>();
        var one = new byte[1];
        while (true)
        {
            var n = await stream.ReadAsync(one);
            if (n <= 0) break;
            if (one[0] == (byte)'\n') break;
            buffer.Add(one[0]);
        }
        var line = Encoding.UTF8.GetString(buffer.ToArray());
        return line.EndsWith('\r') ? line[..^1] : line;
    }

    /// <summary>按"请求路径 + 最后一条消息角色 + 最新用户文本"分场（同 tcode 冒烟剧本）。</summary>
    private static string BuildScript(string path, string body)
    {
        var events = new List<string>();
        void Send(string data) => events.Add($"data: {data}\n\n");
        void Text(string content, string finish)
        {
            Send("{\"choices\":[{\"delta\":{\"content\":\"" + EscapeJson(content) + "\"}}]}");
            Send("{\"choices\":[{\"delta\":{},\"finish_reason\":\"" + finish +
                 "\"}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":3}}");
            Send("[DONE]");
        }

        // ---------- Anthropic 协议分支（/v1/messages） ----------
        if (path.EndsWith("/v1/messages"))
        {
            if (body.Contains("tool_result"))
            {
                // 工具结果已回流：给最终回答
                Send("""{"type":"message_start","message":{"role":"assistant"}}""");
                Send("""{"type":"content_block_start","index":0,"content_block":{"type":"text"}}""");
                Send("""{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"验证完成：smoke-anthropic"}}""");
                Send("""{"type":"content_block_stop","index":0}""");
                Send("""{"type":"message_delta","delta":{"stop_reason":"end_turn"}}""");
                Send("""{"type":"message_stop"}""");
            }
            else
            {
                // 第一轮：正文 + 分两片的 tool_use input（考验碎片拼装）
                Send("""{"type":"message_start","message":{"role":"assistant"}}""");
                Send("""{"type":"content_block_start","index":0,"content_block":{"type":"text"}}""");
                Send("""{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我先跑个命令确认环境。"}}""");
                Send("""{"type":"content_block_stop","index":0}""");
                Send("""{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_smoke","name":"bash"}}""");
                Send("""{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}""");
                Send("""{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"echo smoke-anthropic\"}"}}""");
                Send("""{"type":"content_block_stop","index":1}""");
                Send("""{"type":"message_delta","delta":{"stop_reason":"tool_use"}}""");
                Send("""{"type":"message_stop"}""");
            }
            return string.Join("", events);
        }

        // ---------- OpenAI 协议分支（/v1/chat/completions） ----------
        var lastRole = "";
        var lastText = "";
        try
        {
            if (JsonNode.Parse(body) is JsonObject obj && obj["messages"] is JsonArray messages &&
                messages.Count > 0)
            {
                var last = messages[^1] as JsonObject;
                lastRole = last?["role"]?.GetValue<string>() ?? "";
                lastText = last?["content"]?.GetValue<string>() ?? "";
            }
        }
        catch
        {
            /* 保底走默认分支 */
        }

        if (lastRole == "tool")
        {
            // 工具结果已回流（含被拦截的 web_fetch）：给最终回答
            Text("验证完成：smoke-ok", "stop");
        }
        else if (lastText.Contains("继续"))
        {
            // 场景B：恢复历史后的追问
            Text("好的，继续。", "stop");
        }
        else if (lastText.Contains("试试抓取"))
        {
            // 场景D：诱导抓取内网地址，验证 SSRF 拦截
            Send("""{"choices":[{"delta":{"role":"assistant","content":"我来抓取这个地址试试。"}}]}""");
            Send("""{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_fetch","type":"function","function":{"name":"web_fetch","arguments":"{\"url\":\"http://127.0.0.1:9/private\"}"}}]}}]}""");
            Send("""{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}""");
            Send("[DONE]");
        }
        else
        {
            // 场景A/F第一轮：流式正文 + 一个 bash 工具调用
            Send("""{"choices":[{"delta":{"role":"assistant","content":"我先跑个命令确认环境。"}}]}""");
            Send("""{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_smoke","type":"function","function":{"name":"bash","arguments":"{\"command\":\"echo smoke-ok\"}"}}]}}]}""");
            Send("""{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}""");
            Send("[DONE]");
        }
        return string.Join("", events);
    }

    private static string EscapeJson(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");

    // ---------- 子进程封装 ----------

    private sealed class Proc(Process process, StreamWriter stdin, StringBuilder output, object outputLock)
        : IDisposable
    {
        public void Write(string text) => stdin.WriteLine(text);

        public string Output()
        {
            lock (outputLock) return output.ToString();
        }

        public void WaitContains(string needle, TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                if (Output().Contains(needle, StringComparison.Ordinal)) return;
                Thread.Sleep(50);
            }
            throw new Exception($"冒烟：等不到输出 {needle}；已有：\n{Tail()}");
        }

        public void WaitContainsN(string needle, int count, TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                if (Output().Split(needle).Length - 1 >= count) return;
                Thread.Sleep(50);
            }
            throw new Exception($"冒烟：等不到输出 {needle} ×{count}；已有：\n{Tail()}");
        }

        public void WaitExit(TimeSpan timeout)
        {
            if (!process.WaitForExit((int)timeout.TotalMilliseconds))
            {
                try { process.Kill(true); }
                catch { /* 已退出 */ }
                throw new Exception("冒烟：子进程未在时限内退出；输出：\n" + Tail());
            }
        }

        /// <summary>退出码（WaitExit 之后有效）。</summary>
        public int ExitCode => process.ExitCode;

        private string Tail()
        {
            var s = Output();
            return s.Length <= 6000 ? s : s[^6000..];
        }

        public void Dispose()
        {
            try { stdin.Dispose(); }
            catch { /* 已关闭 */ }
            try { if (!process.HasExited) process.Kill(true); }
            catch { /* 已退出 */ }
            try { process.Dispose(); }
            catch { /* 已退出 */ }
        }
    }

    private static Proc StartProc(string home, string[] appArgs, Dictionary<string, string>? envExtra = null)
    {
        var psi = new ProcessStartInfo
        {
            WorkingDirectory = home,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        if (File.Exists(_exePath))
        {
            psi.FileName = _exePath;
        }
        else
        {
            // 兜底：找不到 apphost 时用 dotnet exec 直跑 dll
            psi.FileName = _dotnetDir.Length > 0 ? Path.Combine(_dotnetDir, "dotnet.exe") : "dotnet";
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add(_dllPath);
        }
        foreach (var arg in appArgs) psi.ArgumentList.Add(arg);

        var env = psi.Environment;
        foreach (var key in env.Keys.Where(k =>
                     k.StartsWith("CCODE_", StringComparison.OrdinalIgnoreCase) ||
                     k is "HOME" or "USERPROFILE").ToList())
            env.Remove(key);
        env["HOME"] = home;
        env["USERPROFILE"] = home;
        env["CCODE_API_KEY"] = "test-key";
        env["CCODE_BASE_URL"] = _serverUrl;
        env["CCODE_MODEL"] = "fake-model";
        if (_dotnetDir.Length > 0) env["DOTNET_ROOT"] = _dotnetDir;
        if (envExtra != null)
            foreach (var (key, value) in envExtra)
                env[key] = value;

        var process = Process.Start(psi) ?? throw new Exception("冒烟：子进程启动失败");
        var stdin = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false))
        {
            AutoFlush = true,
        };
        var output = new StringBuilder();
        var outputLock = new object();

        void Pump(TextReader reader)
        {
            _ = Task.Run(async () =>
            {
                var buffer = new char[4096];
                while (true)
                {
                    var n = await reader.ReadAsync(buffer);
                    if (n <= 0) break;
                    lock (outputLock) output.Append(buffer, 0, n);
                }
            });
        }

        Pump(process.StandardOutput);
        Pump(process.StandardError);

        return new Proc(process, stdin, output, outputLock);
    }

    // ---------- 场景 ----------

    private static string NewHome()
    {
        var home = Path.Combine(Path.GetTempPath(), "ccode-smoke-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(home);
        return home;
    }

    /// <summary>场景A：--yolo 工具闭环——流式正文 → 工具调用 → bash 执行 → 结果回流 → 最终回答。</summary>
    private static void ScenarioA()
    {
        _homeA = NewHome();
        using var proc = StartProc(_homeA, ["--yolo"]);
        proc.Write("跑一下冒烟测试");
        proc.WaitContains("验证完成：smoke-ok", TimeSpan.FromSeconds(30));
        proc.Write("/exit");
        proc.WaitExit(TimeSpan.FromSeconds(10));

        var output = proc.Output();
        Check.Contains("我先跑个命令确认环境。", output, "A: 未见流式正文");
        Check.Contains("验证完成：smoke-ok", output, "A: 未见最终回答");
        Check.Contains("exit=0", output, "A: 未见 bash 工具回显");
        Check.True(BodyContains(0, "\"role\":\"tool\"", "smoke-ok"), "A: 第二轮请求未携带工具结果");
    }

    /// <summary>场景B：退出后重开进程，/resume 列表 → 加载 → 恢复的历史随新请求发给模型。</summary>
    private static void ScenarioB(string home)
    {
        var before = BodiesCount();
        using var proc = StartProc(home, []);
        proc.Write("/resume");
        proc.WaitContains("最近的会话", TimeSpan.FromSeconds(15));
        proc.Write("/resume 1");
        proc.WaitContains("已恢复", TimeSpan.FromSeconds(15));
        proc.Write("继续");
        proc.WaitContains("好的，继续。", TimeSpan.FromSeconds(30));
        proc.Write("/exit");
        proc.WaitExit(TimeSpan.FromSeconds(10));

        var output = proc.Output();
        Check.Contains("跑一下冒烟测试", output, "B: 列表未显示上一会话标签");
        Check.True(BodyContains(before, "跑一下冒烟测试", "继续"),
            $"B: 恢复的历史未随新请求发给模型\n{BodiesTail(before)}\n--- 子进程输出 ---\n{output}");
    }

    /// <summary>场景C：Anthropic 协议（BASE_URL 含 /anthropic 自动识别）完整工具轮，含分片 input_json_delta。</summary>
    private static void ScenarioC()
    {
        var home = NewHome();
        var before = BodiesCount();
        using var proc = StartProc(home, ["--yolo"],
            new Dictionary<string, string> { ["CCODE_BASE_URL"] = _serverUrl + "/anthropic" });
        proc.Write("跑一下 Anthropic 冒烟");
        proc.WaitContains("验证完成：smoke-anthropic", TimeSpan.FromSeconds(30));
        proc.Write("/exit");
        proc.WaitExit(TimeSpan.FromSeconds(10));

        var output = proc.Output();
        Check.Contains("我先跑个命令确认环境。", output, "C: 未见流式正文");
        Check.Contains("smoke-anthropic", output, "C: 未见 bash 工具输出回显");
        Check.True(BodyContains(before, "\"tool_result\"", "smoke-anthropic"), "C: 第二轮请求未携带 tool_result");
        Check.True(BodyContains(before, "\"input_schema\"", "\"max_tokens\"", "\"system\""),
            "C: 请求缺 Anthropic 必备字段（input_schema/max_tokens/system）");
    }

    /// <summary>场景D：诱导 web_fetch 抓内网地址，断言 SSRF 拦截且结果回流、会话正常收尾。</summary>
    private static void ScenarioD()
    {
        var home = NewHome();
        var before = BodiesCount();
        using var proc = StartProc(home, ["--yolo"]);
        proc.Write("试试抓取 http://127.0.0.1:9/private");
        proc.WaitContains("已拦截", TimeSpan.FromSeconds(30));
        proc.WaitContains("验证完成：smoke-ok", TimeSpan.FromSeconds(30));
        proc.Write("/exit");
        proc.WaitExit(TimeSpan.FromSeconds(10));

        Check.Contains("SSRF 防护", proc.Output(), "D: 拦截提示");
        Check.True(BodyContains(before, "\"role\":\"tool\"", "SSRF 防护"),
            $"D: 拦截结果未回流给模型\n{BodiesTail(before)}\n--- 子进程输出 ---\n{proc.Output()}");
    }

    /// <summary>场景F：无 --yolo，stdin 喂 y/n 断言权限 allow/deny 两轮。</summary>
    private static void ScenarioF()
    {
        var home = NewHome();
        var before = BodiesCount();
        using var proc = StartProc(home, []);
        proc.Write("跑一下冒烟测试");
        proc.WaitContains("允许?", TimeSpan.FromSeconds(30)); // 第一轮：bash 权限询问
        Check.Contains("echo smoke-ok", proc.Output(), "F: 预览应含将执行的命令");
        proc.Write("y");
        proc.WaitContains("验证完成：smoke-ok", TimeSpan.FromSeconds(30));

        proc.Write("再来一次");
        proc.WaitContainsN("允许?", 2, TimeSpan.FromSeconds(30)); // 第二轮：同名询问（计数区分）
        proc.Write("n");
        proc.WaitContains("用户已拒绝", TimeSpan.FromSeconds(30));
        proc.Write("/exit");
        proc.WaitExit(TimeSpan.FromSeconds(10));

        Check.True(BodyContains(before, "用户拒绝了本次操作"),
            $"F: 拒绝回执未回流给模型\n{BodiesTail(before)}\n--- 子进程输出 ---\n{proc.Output()}");
    }

    /// <summary>场景H：exec --yolo 无交互模式——位置参数任务、纯文本渲染、工具闭环、退出码 0。</summary>
    private static void ScenarioH()
    {
        var home = NewHome();
        var before = BodiesCount();
        using var proc = StartProc(home, ["exec", "--yolo", "跑一下冒烟测试"]);
        proc.WaitContains("验证完成：smoke-ok", TimeSpan.FromSeconds(30));
        proc.WaitExit(TimeSpan.FromSeconds(10));

        var output = proc.Output();
        Check.Contains("我先跑个命令确认环境。", output, "H: 未见流式正文");
        Check.Contains("[tool] bash", output, "H: 未见工具事件行");
        Check.Contains("[result] exit=0", output, "H: 未见工具结果行");
        Check.Contains("验证完成：smoke-ok", output, "H: 未见最终回答");
        Check.Eq(0, proc.ExitCode, "H: exec 正常完成退出码应为 0");
        Check.True(BodyContains(before, "\"role\":\"tool\"", "smoke-ok"),
            $"H: 第二轮请求未携带工具结果\n{BodiesTail(before)}\n--- 子进程输出 ---\n{output}");
    }

    // ---------- 断言用共享状态 ----------

    private static int BodiesCount()
    {
        lock (Lock) return Bodies.Count;
    }

    private static bool BodyContains(int from, params string[] needles)
    {
        lock (Lock)
        {
            return Bodies.Skip(from).Any(body => needles.All(body.Contains));
        }
    }

    /// <summary>诊断用：断言失败时转储请求体片段。</summary>
    private static string BodiesTail(int from)
    {
        lock (Lock)
        {
            var parts = Bodies.Skip(from)
                .Select((b, i) => $"-- body[{from + i}] ({b.Length} chars)：{Trunc(b, 600)}");
            return string.Join("\n", parts);
        }
    }

    private static string Trunc(string s, int max) => s.Length <= max ? s : s[..max] + "…";
}
