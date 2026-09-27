"""会话持久化单测：append 静默失败契约——写失败（任何异常）不打断对话。

镜像 tcode core/session.ts 的纪律「记会话是锦上添花，不该打断对话」：
append 的静默不限于 OSError，任何写路径异常都不许穿透到对话层。
"""
from __future__ import annotations

import tempfile
import unittest
from unittest import mock

from pcode.core.session import SessionStore


class AppendSilentTest(unittest.TestCase):
    def test_append未start时直接返回(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SessionStore(tmp)
            store.append({'role': 'user', 'content': 'hi'})  # 无会话文件，静默返回

    def test_append任何异常静默_永不打断对话(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SessionStore(tmp)
            store.start({})
            with mock.patch('builtins.open', side_effect=RuntimeError('磁盘炸了')):
                store.append({'role': 'user', 'content': 'hi'})  # 非 OSError 也应静默


if __name__ == '__main__':
    unittest.main()
