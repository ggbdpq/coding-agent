// 重试纪律：两种协议客户端共用。仅首字节前可重试（流已开始的中断不重试，避免内容重复）。
// 同步模型下的语义：send_string 返回 Response 即已收到首字节，之后的错误一律 Fatal。
use std::time::Duration;

use crate::kernel::types::{ChatError, CompletionResult};

const MAX_ATTEMPTS: usize = 3;

/// 最多 3 次尝试，指数退避 1s/2s；不可重试错误（含用户中止）立即返回。
pub fn with_retry(
    run: impl Fn() -> Result<CompletionResult, ChatError>,
) -> Result<CompletionResult, ChatError> {
    for attempt in 0..MAX_ATTEMPTS {
        match run() {
            Ok(res) => return Ok(res),
            Err(ChatError::Fatal(e)) => return Err(ChatError::Fatal(e)),
            Err(ChatError::Retryable(e)) => {
                if attempt == MAX_ATTEMPTS - 1 {
                    return Err(ChatError::Retryable(e));
                }
                std::thread::sleep(Duration::from_secs(1 << attempt)); // 1s, 2s
            }
        }
    }
    unreachable!("循环内必然 return")
}
