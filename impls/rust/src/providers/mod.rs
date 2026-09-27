// providers：协议客户端 + provider 插件。只 import kernel，不 import core/plugins/shell。
pub mod anthropic;
pub mod openai;
pub mod retry;
pub mod sse;
