"""技能索引扫描的错误契约（学自 zai-org/ZCode skills/scan.ts，按闭包语境修订）：
目录不存在静默跳过；权限等错误 stderr 警告一行后跳过——不静默（用户看得见），
也不打断启动（技能索引是可选增强，skill_index 在 fresh_messages 闭包语境被调用）。
"""
from __future__ import annotations

import io
import tempfile
import unittest
from unittest import mock

from pcode.core.systemprompt import skill_index


class SkillIndexErrorContractTest(unittest.TestCase):
    def test_目录不存在静默跳过(self) -> None:
        self.assertIsNone(skill_index(['Z:\\surely-not-exist\\skills']))

    def test_权限错误stderr警告并跳过_不静默不崩溃(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = io.StringIO()
            with mock.patch('os.listdir', side_effect=PermissionError('拒绝访问')):
                with mock.patch('sys.stderr', stderr):
                    result = skill_index([tmp])
        self.assertIsNone(result, '不可读目录应被跳过')
        self.assertIn('跳过不可读目录', stderr.getvalue(), '必须 stderr 警告，不允许静默')


if __name__ == '__main__':
    unittest.main()
