// OpenAI 兼容 /chat/completions 客户端 + 对应 provider 插件（兜底：matches 恒真）。
// 只支持流式——coding agent 的体感底线，也顺便让工具调用前的等待可见。
// SSE 手写解析（sse.rs）：按空行分事件；tool_calls 按 index 分槽拼装 arguments 碎片。
use std::collections::BTreeMap;
use std::rc::Rc;

use serde_json::{Map, Value};

use super::retry::with_retry;
use super::sse::sse_data;
use crate::kernel::config::Config;
use crate::kernel::plugin::{Plugin, ProviderDef};
use crate::kernel::types::{
    ChatClient, ChatError, ChatMessage, ChatOptions, CompletionResult, ToolCall, ToolSchema, Usage,
};

pub struct OpenAIProvider {
    base_url: String,
    api_key: String,
    model: String,
    agent: ureq::Agent,
}

impl OpenAIProvider {
    pub fn new(config: &Config) -> Self {
        OpenAIProvider {
            base_url: config.base_url.clone(),
            api_key: config.api_key.clone(),
            model: config.model.clone(),
            // 依赖政策落点：关自动重定向，端点不该把对话请求 302 走
            agent: ureq::AgentBuilder::new().redirects(0).build(),
        }
    }

    fn attempt(
        &self,
        messages: &[ChatMessage],
        opts: &ChatOptions,
    ) -> Result<CompletionResult, ChatError> {
        // 请求体：{model, messages, tools?, stream:true}（tools 空省略，对齐 tcode）
        let mut body = Map::new();
        body.insert("model".into(), Value::String(self.model.clone()));
        body.insert(
            "messages".into(),
            Value::Array(messages.iter().map(ChatMessage::to_value).collect()),
        );
        if !opts.tools.is_empty() {
            body.insert(
                "tools".into(),
                Value::Array(opts.tools.iter().map(ToolSchema::to_value).collect()),
            );
        }
        body.insert("stream".into(), Value::Bool(true));
        // R5：include_usage 让服务端在流末尾补一个带 usage 的分片（该分片 choices 为空）
        let mut stream_options = Map::new();
        stream_options.insert("include_usage".into(), Value::Bool(true));
        body.insert("stream_options".into(), Value::Object(stream_options));

        let mut req = self
            .agent
            .post(&format!("{}/chat/completions", self.base_url))
            .set("content-type", "application/json")
            .set("authorization", &format!("Bearer {}", self.api_key));
        if let Some(t) = opts.timeout {
            req = req.timeout(t);
        }
        let resp = req
            .send_string(&Value::Object(body).to_string())
            .map_err(http_error_to_chat_error)?;

        // 流式增量装配：正文直接累加；工具调用按 index 分槽拼装碎片
        let on_text = opts.on_text;
        let on_usage = opts.on_usage;
        let mut content = String::new();
        let mut calls: BTreeMap<usize, CallSlot> = BTreeMap::new();
        sse_data(resp.into_reader(), |data| {
            if data == "[DONE]" {
                return false;
            }
            let chunk: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => return true, // 非 JSON 行（注释、心跳）直接跳过
            };
            // usage 分片（R5）：choices 为空也带 token 用量，必须先于 choices 判空消费，
            // 否则流末尾的 usage 分片会被跳过、永远收不到
            if let Some(cb) = on_usage {
                let usage = &chunk["usage"];
                let p = usage["prompt_tokens"].as_u64().unwrap_or(0);
                let c = usage["completion_tokens"].as_u64().unwrap_or(0);
                if p > 0 || c > 0 {
                    cb(Usage { prompt_tokens: p, completion_tokens: c });
                }
            }
            let delta = &chunk["choices"][0]["delta"];
            if let Some(c) = delta["content"].as_str() {
                if !c.is_empty() {
                    content.push_str(c);
                    if let Some(cb) = on_text {
                        cb(c);
                    }
                }
            }
            if let Some(tcs) = delta["tool_calls"].as_array() {
                for tc in tcs {
                    let index = tc["index"].as_u64().unwrap_or(0) as usize;
                    let slot = calls.entry(index).or_default();
                    if let Some(id) = tc["id"].as_str() {
                        if !id.is_empty() {
                            slot.id = id.to_string();
                        }
                    }
                    if let Some(name) = tc["function"]["name"].as_str() {
                        if !name.is_empty() {
                            slot.name.push_str(name);
                        }
                    }
                    if let Some(a) = tc["function"]["arguments"].as_str() {
                        if !a.is_empty() {
                            slot.args.push_str(a);
                        }
                    }
                }
            }
            true
        });
        // 已进入正文读取：流中断视作完成（与 tcode/gcode 相同取向）

        let tool_calls: Vec<ToolCall> = calls
            .into_iter()
            .map(|(i, s)| ToolCall {
                id: if s.id.is_empty() { format!("call_{}", i) } else { s.id },
                name: s.name,
                arguments: if s.args.is_empty() { "{}".to_string() } else { s.args },
            })
            .collect();
        Ok(CompletionResult {
            message: ChatMessage::assistant(nil_or_text(content), tool_calls),
        })
    }
}

#[derive(Default)]
struct CallSlot {
    id: String,
    name: String,
    args: String,
}

impl ChatClient for OpenAIProvider {
    /// 最多 3 次尝试；仅首字节前可重试（流已开始的中断不重试，避免内容重复）。
    fn chat(&self, messages: &[ChatMessage], opts: &ChatOptions) -> Result<CompletionResult, ChatError> {
        with_retry(|| self.attempt(messages, opts))
    }
}

/// 空串 → null（线格式 content:null，对齐 tcode 的 `content || null`）。
pub(crate) fn nil_or_text(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// ureq 错误 → ChatError：429/5xx 可重试（读一小段响应体进错误信息），传输层错误可重试。
pub(crate) fn http_error_to_chat_error(e: ureq::Error) -> ChatError {
    match e {
        ureq::Error::Status(code, resp) => {
            let mut brief = String::new();
            if let Ok(t) = resp.into_string() {
                brief = t;
            }
            let brief: String = if brief.chars().count() > 300 {
                format!("{}…", brief.chars().take(300).collect::<String>())
            } else {
                brief
            };
            let msg = format!("HTTP {}：{}", code, brief);
            if code == 429 || code >= 500 {
                ChatError::Retryable(msg)
            } else {
                ChatError::Fatal(msg)
            }
        }
        ureq::Error::Transport(t) => ChatError::Retryable(format!("{}", t)),
    }
}

/// OpenAI provider 插件：matches 恒真，是兜底——清单里必须排在 provider 类的最后。
pub fn openai_plugin() -> Plugin {
    Plugin::Provider(Rc::new(ProviderDef {
        name: "openai",
        matches: Rc::new(|_base_url: &str| true),
        create: Rc::new(|config: &Config| Rc::new(OpenAIProvider::new(config)) as Rc<dyn ChatClient>),
    }))
}
