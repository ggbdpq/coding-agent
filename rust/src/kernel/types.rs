// 共享词汇表：两种协议与核心逻辑共同依赖的线格式类型。
// 放 kernel 是因为 core/providers/session 都要引用，且不含任何行为。
// JSON 一律 serde_json::Value 操作（依赖政策：不引 serde derive），序列化手写。
use serde_json::{Map, Value};
use std::rc::Rc;

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

/// 单次补全的可选项。on_text 是正文增量回调（工具调用参数不走这里）。
/// 全项目单线程同步模型（见 ARCHITECTURE.md），回调统一用 Rc 而非线程安全约束。
pub struct ChatOptions {
    pub tools: Vec<ToolSchema>,
    pub on_text: Option<Rc<dyn Fn(&str)>>,
}

impl Default for ChatOptions {
    fn default() -> Self {
        ChatOptions { tools: vec![], on_text: None }
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
