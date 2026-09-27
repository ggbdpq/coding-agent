"""重试纪律：两种协议客户端共用。仅首字节前可重试（流已开始的中断不重试，避免内容重复）。"""
from __future__ import annotations

import time
import urllib.error
from typing import Callable

from pcode.kernel.types import CompletionResult

_MAX_ATTEMPTS = 3


class RetryableError(Exception):
    """标记可重试的错误（HTTP 429/5xx、网络层失败）；流已开始后不重试。"""


def with_retry(run: Callable[[], CompletionResult]) -> CompletionResult:
    """最多 3 次尝试，指数退避 1s/2s；KeyboardInterrupt（用户中止的等价物）绝不重试。"""
    last: BaseException = RuntimeError('重试循环未执行')
    for attempt in range(_MAX_ATTEMPTS):
        try:
            return run()
        except KeyboardInterrupt:
            raise
        except urllib.error.HTTPError:
            # 不可重试的 HTTP 状态（正常应已被客户端转换；漏网按不可重试处理）
            raise
        except RetryableError as e:
            last = e
        except (urllib.error.URLError, OSError) as e:
            # 网络层失败（连接被拒/DNS/超时），只可能发生在首字节之前 → 可重试
            last = e
        if attempt == _MAX_ATTEMPTS - 1:
            raise last
        time.sleep(1.0 * 2**attempt)
    raise last
