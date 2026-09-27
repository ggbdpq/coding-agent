using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ccode.kernel;

namespace ccode.core;

/// <summary>
/// 会话持久化：JSONL 追加写，一行一条 JSON（meta 行 + message 行）。
/// /resume 的语义 = 读旧文件、换新文件继续写——避免追加到可能损坏的旧文件。
/// 目录边界：所有读写都限定在会话目录内，出目录一律拒绝/跳过。
/// </summary>
public sealed class SessionStore : ISessionStore
{
    private string? _filePath;

    /// <summary>归一化后的会话目录绝对路径。</summary>
    private readonly string _root;

    public SessionStore(string dir)
    {
        _root = Path.GetFullPath(dir);
        Directory.CreateDirectory(_root);
    }

    /// <summary>目录边界校验：目标必须是本目录本身或其子路径。</summary>
    private bool IsInsideDir(string target) =>
        target == _root || target.StartsWith(_root + Path.DirectorySeparatorChar);

    /// <summary>开新会话文件并写入元信息行。</summary>
    public void Start(IReadOnlyDictionary<string, object?>? meta = null)
    {
        // Windows 文件名禁 :，把 ISO 时间的冒号一并换掉
        var name = $"{DateTime.UtcNow:yyyy'-'MM'-'dd'T'HH'-'mm'-'ss'-'fff}-{RandomSuffix()}.jsonl";
        var file = Path.GetFullPath(Path.Combine(_root, name));
        if (!IsInsideDir(file)) throw new InvalidOperationException("会话文件路径越界");
        _filePath = file;
        var line = new JsonObject
        {
            ["type"] = "meta",
            ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        if (meta != null)
            foreach (var (key, value) in meta)
                line[key] = ToNode(value);
        File.AppendAllText(_filePath, line.ToJsonString(JsonUtil.WireOptions) + "\n", Ui.Utf8NoBom);
    }

    /// <summary>追加一条消息；落盘失败静默（记会话是锦上添花，不该打断对话）。</summary>
    public void Append(ChatMessage message)
    {
        if (_filePath is null) return;
        try
        {
            var line = new JsonObject { ["type"] = "message", ["message"] = ChatMessageJson.ToNode(message) };
            File.AppendAllText(_filePath, line.ToJsonString(JsonUtil.WireOptions) + "\n", Ui.Utf8NoBom);
        }
        catch
        {
            /* 忽略 */
        }
    }

    /// <summary>最近 n 个会话（排除当前文件），按修改时间倒序。</summary>
    public List<SessionSummary> ListRecent(int n)
    {
        return Directory.GetFiles(_root, "*.jsonl")
            .Select(Path.GetFullPath)
            .Where(file => IsInsideDir(file) && file != _filePath)
            .Select(file => (File: file, Mtime: File.GetLastWriteTimeUtc(file)))
            .OrderByDescending(x => x.Mtime)
            .Take(n)
            .Select(x => new SessionSummary(
                x.File,
                new DateTimeOffset(x.Mtime).ToUnixTimeMilliseconds(),
                ReadLabel(x.File)))
            .ToList();
    }

    /// <summary>读指定会话文件的全部消息行；越出会话目录的路径一律拒绝。</summary>
    public List<ChatMessage> Load(string file)
    {
        var resolved = Path.GetFullPath(file);
        var messages = new List<ChatMessage>();
        if (!IsInsideDir(resolved) || !File.Exists(resolved)) return messages;
        foreach (var raw in File.ReadAllLines(resolved))
        {
            if (string.IsNullOrWhiteSpace(raw)) continue;
            try
            {
                if (JsonNode.Parse(raw) is not JsonObject line) continue;
                if (JsonUtil.Str(line["type"]) != "message") continue;
                if (line["message"] is JsonObject messageNode && ChatMessageJson.FromNode(messageNode) is { } message)
                    messages.Add(message);
            }
            catch
            {
                /* 跳过坏行 */
            }
        }
        return messages;
    }

    /// <summary>首条用户输入，用作列表标签（前 60 字符）。</summary>
    private string ReadLabel(string file)
    {
        if (!IsInsideDir(file)) return "(无用户消息)";
        try
        {
            foreach (var raw in File.ReadAllLines(file))
            {
                if (string.IsNullOrWhiteSpace(raw)) continue;
                try
                {
                    if (JsonNode.Parse(raw) is not JsonObject line) continue;
                    if (JsonUtil.Str(line["type"]) != "message") continue;
                    if (line["message"] is not JsonObject message) continue;
                    if (JsonUtil.Str(message["role"]) != "user") continue;
                    var text = (JsonUtil.Str(message["content"]) ?? "").Trim();
                    text = Regex.Replace(text, @"\s+", " ");
                    if (text.Length > 0) return text.Length > 60 ? text[..60] : text;
                }
                catch
                {
                    /* 跳过坏行 */
                }
            }
        }
        catch
        {
            /* 读不了当作没有 */
        }
        return "(无用户消息)";
    }

    private static string RandomSuffix() => Guid.NewGuid().ToString("N")[..4];

    private static JsonNode? ToNode(object? value) => value switch
    {
        null => null,
        string s => s,
        bool b => b,
        int i => i,
        long l => l,
        _ => value.ToString(),
    };
}
