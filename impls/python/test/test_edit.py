"""edit 工具单测：唯一性判定是误伤防线，锁死行为。"""
from __future__ import annotations

import unittest

from pcode.plugins.tools.edit import apply_edit


class ApplyEditTest(unittest.TestCase):
    def test_唯一匹配时替换成功(self) -> None:
        r = apply_edit('const a = 1;\nconst b = 2;', 'const b = 2;', 'const b = 3;', False)
        self.assertTrue(r.ok)
        self.assertEqual(r.message, 'one')

    def test_未找到时报错并提示核对原文(self) -> None:
        r = apply_edit('hello', 'world', 'x', False)
        self.assertFalse(r.ok)
        self.assertIn('未找到', r.message)

    def test_多处出现且未开replace_all时拒绝(self) -> None:
        r = apply_edit('x = 1; x = 2;', 'x = ', 'y = ', False)
        self.assertFalse(r.ok)
        self.assertIn('2 次', r.message)

    def test_replace_all档位放行(self) -> None:
        r = apply_edit('a\nb\na', 'a', 'c', True)
        self.assertTrue(r.ok)
        self.assertEqual(r.message, 'all')

    def test_空old_string拒绝(self) -> None:
        r = apply_edit('abc', '', 'x', False)
        self.assertFalse(r.ok)


if __name__ == '__main__':
    unittest.main()
