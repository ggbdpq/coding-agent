// Anthropic Messages 协议客户端（POST {baseUrl}/v1/messages）+ provider 插件：
// 服务于 Claude 官方 API、DeepSeek /anthropic 端点及同类兼容中转。
// 消息映射：system 提为顶层参数；tool 消息转为 user 角色的 tool_result 块；
// 相邻同角色消息合并（Anthropic 要求 user/assistant 严格交替）。
use std::collections::BTreeMap;
use std::rc::Rc;

use serde_json::{Map, Value};

use super::openai::nil_or_text;
use super::retry::with_retry;
use super::sse::sse_data;
use crate::kernel::config::Config;
use crate::kernel::plugin::{Plugin, ProviderDef};
use crate::kernel::types::{
    ChatClient, ChatError, ChatMessage, ChatOptions, CompletionResult, ToolCall, ToolSchema, Usage,
};

/// 协议版本头。
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Anthropic 必填的 max_tokens。
const DEFAULT_MAX_TOKENS: i64 = 8192;

/// 内部（OpenAI 形状）消息 → Anthropic 请求体。纯函数。
pub fn to_anthropic_request(
    messages: &[ChatMessage],
    model: &str,
    max_tokens: i64,
    tools: &[ToolSchema],
) -> Value {
    let mut system: Vec<String> = Vec::new();
    struct Flat {
        role: &'static str,
        content: Vec<Value>,
    }
    let mut flat: Vec<Flat> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "system" => {
                if !m.text().is_empty() {
                    system.push(m.text().to_string());
                }
            }
            "user" => flat.push(Flat {
                role: "user",
                content: vec![serde_json::json!({"type": "text", "text": m.text()})],
            }),
            "tool" => flat.push(Flat {
                role: "user",
                content: vec![serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                    "content": m.text()
                })],
            }),
            _ => {
                // assistant：text 块（有正文才有）+ tool_use 块
                let mut blocks: Vec<Value> = Vec::new();
                if !m.text().is_empty() {
                    blocks.push(serde_json::json!({"type": "text", "text": m.text()}));
                }
                for tc in &m.tool_calls {
                    let input: Value = if tc.arguments.trim().is_empty() {
                        serde_json::json!({})
                    } else {
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}))
                        // 非法参数保持 {}，让对端/工具层报错
                    };
                    blocks.push(serde_json::json!({
                        "type": "tool_use", "id": tc.id, "name": tc.name, "input": input
                    }));
                }
                flat.push(Flat { role: "assistant", content: blocks });
            }
        }
    }
    // 相邻同角色合并
    let mut merged: Vec<(&'static str, Vec<Value>)> = Vec::new();
    for f in flat {
        if let Some(last) = merged.last_mut() {
            if last.0 == f.role {
                last.1.extend(f.content);
                continue;
            }
        }
        merged.push((f.role, f.content));
    }

    let mut body = Map::new();
    body.insert("model".into(), Value::String(model.to_string()));
    body.insert("max_tokens".into(), serde_json::json!(max_tokens));
    body.insert(
        "messages".into(),
        Value::Array(
            merged
                .into_iter()
                .map(|(role, content)| serde_json::json!({"role": role, "content": content}))
                .collect(),
        ),
    );
    body.insert("stream".into(), Value::Bool(true));
    if !system.is_empty() {
        body.insert("system".into(), Value::String(system.join("\n")));
    }
    if !tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(
                tools
                    .iter()
                    .map(|t| {
                        serde_json::json!({
                            "name": t.name,
                            "description": t.description,
                            "input_schema": t.parameters
                        })
                    })
                    .collect(),
            ),
        );
    }
    Value::Object(body)
}

#[derive(Default)]
struct AnthroSlot {
    id: String,
    name: String,
    json: String,
}

pub struct AnthropicProvider {
    base_url: String,
    api_key: String,
    model: String,
    agent: ureq::Agent,
}

impl AnthropicProvider {
    pub fn new(config: &Config) -> Self {
        AnthropicProvider {
            base_url: config.base_url.clone(),
            api_key: config.api_key.clone(),
            model: config.model.clone(),
            agent: ureq::AgentBuilder::new().redirects(0).build(),
        }
    }

    fn attempt(
        &self,
        messages: &[ChatMessage],
        opts: &ChatOptions,
    ) -> Result<CompletionResult, ChatError> {
        let body = to_anthropic_request(messages, &self.model, DEFAULT_MAX_TOKENS, &opts.tools);
        let mut req = self
            .agent
            .post(&format!("{}/v1/messages", self.base_url))
            .set("content-type", "application/json")
            .set("x-api-key", &self.api_key)
            .set("authorization", &format!("Bearer {}", self.api_key))
            .set("anthropic-version", ANTHROPIC_VERSION);
        if let Some(t) = opts.timeout {
            req = req.timeout(t);
        }
        let resp = req
            .send_string(&body.to_string())
            .map_err(super::openai::http_error_to_chat_error)?;

        // 事件装配：text_delta 累加正文；tool_use 块按 index 收 input_json_delta 碎片
        let on_text = opts.on_text;
        let on_usage = opts.on_usage;
        let mut text = String::new();
        let mut tool_blocks: BTreeMap<usize, AnthroSlot> = BTreeMap::new();
        let mut in_stream_error: Option<String> = None;
        sse_data(resp.into_reader(), |data| {
            let ev: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => return true,
            };
            if ev["type"] == "error" {
                let msg = ev["error"]["message"].as_str().unwrap_or(data).to_string();
                in_stream_error = Some(format!("流内错误：{}", msg));
                return false;
            }
            if ev["type"] == "content_block_start" && ev["content_block"]["type"] == "tool_use" {
                let index = ev["index"].as_u64().unwrap_or(0) as usize;
                tool_blocks.insert(
                    index,
                    AnthroSlot {
                        id: ev["content_block"]["id"].as_str().unwrap_or("").to_string(),
                        name: ev["content_block"]["name"].as_str().unwrap_or("").to_string(),
                        json: String::new(),
                    },
                );
                return true;
            }
            if ev["type"] == "content_block_delta" {
                let d = &ev["delta"];
                match d["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        if let Some(t) = d["text"].as_str() {
                            if !t.is_empty() {
                                text.push_str(t);
                                if let Some(cb) = on_text {
                                    cb(t);
                                }
                            }
                        }
                    }
                    "input_json_delta" => {
                        if let Some(pj) = d["partial_json"].as_str() {
                            if !pj.is_empty() {
                                if let Some(b) = tool_blocks.get_mut(&(ev["index"].as_u64().unwrap_or(0) as usize)) {
                                    b.json.push_str(pj);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            // message_start/message_delta 携带 token 用量（R5）：message_start 给
            // input/output 初值，message_delta 给累计值；逐事件回调，不做合流"优化"
            let usage = if ev["type"] == "message_start" { &ev["message"]["usage"] } else { &ev["usage"] };
            if usage.is_object() {
                let input = usage["input_tokens"].as_u64().unwrap_or(0);
                let output = usage["output_tokens"].as_u64().unwrap_or(0);
                if (input > 0 || output > 0) && on_usage.is_some() {
                    (on_usage.unwrap())(Usage { prompt_tokens: input, completion_tokens: output });
                }
            }
            // message_delta / message_stop / ping：块拼完即返回，无需特殊处理
            true
        });
        if let Some(err) = in_stream_error {
            return Err(ChatError::Fatal(err));
        }

        let tool_calls: Vec<ToolCall> = tool_blocks
            .into_iter()
            .map(|(i, b)| {
                // 解析一遍再序列化：既验证 JSON 完整性，也归一成内部 arguments 字符串；
                // 流被截断时保留原文，工具层的参数解析会兜底报错
                let args = if b.json.trim().is_empty() {
                    "{}".to_string()
                } else {
                    serde_json::from_str::<Value>(&b.json).map_or_else(|_| b.json.clone(), |v| v.to_string())
                };
                ToolCall {
                    id: if b.id.is_empty() { format!("toolu_{}", i) } else { b.id },
                    name: b.name,
                    arguments: args,
                }
            })
            .collect();
        Ok(CompletionResult {
            message: ChatMessage::assistant(nil_or_text(text), tool_calls),
        })
    }
}

impl ChatClient for AnthropicProvider {
    /// 与 OpenAI 版相同的重试纪律：最多 3 次，仅首字节前可重试。
    fn chat(&self, messages: &[ChatMessage], opts: &ChatOptions) -> Result<CompletionResult, ChatError> {
        with_retry(|| self.attempt(messages, opts))
    }
}

/// Anthropic provider 插件：BASE_URL 含 /anthropic 时命中。
pub fn anthropic_plugin() -> Plugin {
    Plugin::Provider(Rc::new(ProviderDef {
        name: "anthropic",
        matches: Rc::new(|base_url: &str| base_url.contains("/anthropic")),
        create: Rc::new(|config: &Config| Rc::new(AnthropicProvider::new(config)) as Rc<dyn ChatClient>),
    }))
}
