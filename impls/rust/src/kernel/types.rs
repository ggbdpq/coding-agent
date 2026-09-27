// 共享词汇表：两种协议与核心逻辑共同依赖的线格式类型。
// 放 kernel 是因为 core/providers/session 都要引用，且不含任何行为。
// JSON 一律 serde_json::Value 操作（依赖政策：不引 serde derive），序列化手写。
use serde_json::{Map, Value};

/// 协议名（RCODE_PROTOCOL 只认这两个值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    OpenAI,
    Anthropic,
}

impl Protocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            Protocol::OpenAI => "openai",
            Protocol::Anthropic => "anthropic",
        }
    }
}

/// function calling 的 tools 参数元素（OpenAI 形状）。
#[derive(Debug, Clone)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    /// JSON Schema，直传 function calling
    pub parameters: Value,
}

impl ToolSchema {
    /// 序列化为线格式：{"type":"function","function":{name,description,parameters}}
    pub fn to_value(&self) -> Value {
        let mut function = Map::new();
        function.insert("name".into(), Value::String(self.name.clone()));
        function.insert("description".into(), Value::String(self.description.clone()));
        function.insert("parameters".into(), self.parameters.clone());
        let mut obj = Map::new();
        obj.insert("type".into(), Value::String("function".into()));
        obj.insert("function".into(), Value::Object(function));
        Value::Object(obj)
    }
}

/// assistant 消息里的工具调用（内部形状：function 拍平为 name/arguments 两个字段）。
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// JSON 字符串，两种协议通用
    pub arguments: String,
}

/// 内部统一消息形状（OpenAI 线格式）；Anthropic 客户端负责换算。
/// content 用 Option 区分"没有正文"（None→null）与空串。
#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn system(text: impl Into<String>) -> Self {
        ChatMessage { role: "system".into(), content: Some(text.into()), tool_calls: vec![], tool_call_id: None }
    }

    pub fn user(text: impl Into<String>) -> Self {
        ChatMessage { role: "user".into(), content: Some(text.into()), tool_calls: vec![], tool_call_id: None }
    }

    pub fn assistant(content: Option<String>, tool_calls: Vec<ToolCall>) -> Self {
        ChatMessage { role: "assistant".into(), content, tool_calls, tool_call_id: None }
    }

    pub fn tool(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        ChatMessage { role: "tool".into(), content: Some(content.into()), tool_calls: vec![], tool_call_id: Some(tool_call_id.into()) }
    }

    /// 正文（None 视为空串）。
    pub fn text(&self) -> &str {
        self.content.as_deref().unwrap_or("")
    }

    /// 序列化为 OpenAI 线格式（会话 JSONL 与请求体共用）。
    /// 对齐 tcode：tool_calls 为空省略；content 为空时是 null 而非 ""。
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("role".into(), Value::String(self.role.clone()));
        m.insert(
            "content".into(),
            self.content.clone().map(Value::String).unwrap_or(Value::Null),
        );
        if !self.tool_calls.is_empty() {
            let arr: Vec<Value> = self
                .tool_calls
                .iter()
                .map(|tc| {
                    let mut function = Map::new();
                    function.insert("name".into(), Value::String(tc.name.clone()));
                    function.insert("arguments".into(), Value::String(tc.arguments.clone()));
                    let mut t = Map::new();
                    t.insert("id".into(), Value::String(tc.id.clone()));
                    t.insert("type".into(), Value::String("function".into()));
                    t.insert("function".into(), Value::Object(function));
                    Value::Object(t)
                })
                .collect();
            m.insert("tool_calls".into(), Value::Array(arr));
        }
        if let Some(id) = &self.tool_call_id {
            m.insert("tool_call_id".into(), Value::String(id.clone()));
        }
        Value::Object(m)
    }

    /// 从 JSON 行（会话文件 / API 响应）恢复；没有 role 视为非法。
    pub fn from_value(v: &Value) -> Option<ChatMessage> {
        let role = v.get("role")?.as_str()?.to_string();
        let content = match v.get("content") {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        };
        let mut tool_calls = Vec::new();
        if let Some(arr) = v.get("tool_calls").and_then(Value::as_array) {
            for tc in arr {
                let id = tc.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let name = tc
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let arguments = tc
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                tool_calls.push(ToolCall { id, name, arguments });
            }
        }
        let tool_call_id = v.get("tool_call_id").and_then(Value::as_str).map(str::to_string);
        Some(ChatMessage { role, content, tool_calls, tool_call_id })
    }
}

/// 一次补全的产物。
pub struct CompletionResult {
    pub message: ChatMessage,
}

/// 一次补全的 token 用量（provider 从协议流里解析，R5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// 单次补全的可选项。on_text 是正文增量回调（工具调用参数不走这里）。
/// 回调用借用（&dyn Fn）而非 Rc：provider 在同步调用栈内即用即还，
/// 生命周期由调用方（turn 的栈帧）保证，不引入 'static 约束。
/// timeout 是整个请求（含响应体读取）的上限；None=不设。摘要压缩请求设 20s——
/// stdlib 没有用户中止信号，超时就是同步模型下的"取消"。
pub struct ChatOptions<'a> {
    pub tools: Vec<ToolSchema>,
    pub on_text: Option<&'a dyn Fn(&str)>,
    /// token 用量回调（R5）：openai 由 stream_options.include_usage 的 usage 分片
    /// 触发；anthropic 来自 message_start/message_delta。无用量不触发。
    pub on_usage: Option<&'a dyn Fn(Usage)>,
    pub timeout: Option<std::time::Duration>,
}

impl<'a> Default for ChatOptions<'a> {
    fn default() -> Self {
        ChatOptions { tools: vec![], on_text: None, on_usage: None, timeout: None }
    }
}

/// 标记可重试的错误分类（HTTP 429/5xx/网络层失败）；流已开始后的中断不可重试。
/// 放 kernel 是因为 ChatClient 签名引用它；with_retry 逻辑在 providers/retry.rs。
#[derive(Debug, Clone)]
pub enum ChatError {
    Retryable(String),
    Fatal(String),
}

impl std::fmt::Display for ChatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChatError::Retryable(m) => write!(f, "{}", m),
            ChatError::Fatal(m) => write!(f, "{}", m),
        }
    }
}

/// 两种协议客户端的共同形状：agentloop 只认这个。
/// &self 即可（ureq::Agent 无状态复用），无需 &mut。
pub trait ChatClient {
    fn chat(&self, messages: &[ChatMessage], opts: &ChatOptions) -> Result<CompletionResult, ChatError>;
}

/// turn 终态原因：completed=模型收尾；aborted=用户中止（同步模型无此路径——
/// Ctrl+C 是进程级默认退出，保留变体是为对齐 tcode 事件契约）；error=异常。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnEndReason {
    Completed,
    Aborted,
    Error,
}

/// 规范事件流（v1 事件模型）：turn 是唯一生产者，壳/审计/测试是消费者。
/// Permission 是占位契约（权限走壳侧回调）；Usage/Compact 自 v0.4 起有生产者
/// （provider usage 解析、轮前治理双档）——加功能=加事件变体，不动消费端接口。
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    TurnStart { id: String },
    User { text: String },
    TextDelta { delta: String },
    ToolCall { call_id: String, name: String, args: Value },
    ToolResult { call_id: String, name: String, summary: String, ms: u64 },
    Permission { id: String, tool: String, preview: String },
    Trimmed { count: usize },
    /// 上下文压缩完成（轮前治理 80% 档或 /compact），节省的估算 token 数
    Compact { saved_tokens: u64 },
    Usage { prompt_tokens: u64, completion_tokens: u64 },
    TurnEnd { reason: TurnEndReason, error: Option<String> },
}
