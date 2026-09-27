"""技能索引扫描的错误契约（学自 zai-org/ZCode skills/scan.ts）：
目录不存在静默跳过；权限等错误必须上抛——静默空索引会让模型以为没有技能。
"""
from __future__ import annotations

import tempfile
import unittest
from unittest import mock

from pcode.core.systemprompt import skill_index


class SkillIndexErrorContractTest(unittest.TestCase):
    def test_目录不存在静默跳过(self) -> None:
        self.assertIsNone(skill_index(['Z:\\surely-not-exist\\skills']))

    def test_权限错误必须上抛_防静默空索引(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch('os.listdir', side_effect=PermissionError('拒绝访问')):
                with self.assertRaises(PermissionError):
                    skill_index([tmp])


if __name__ == '__main__':
    unittest.main()
