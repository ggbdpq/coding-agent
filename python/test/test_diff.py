"""diff 预览单测：前缀 +/-、公共上下文收敛、截断标注（镜像 tcode test/diff.test.ts）。"""
from __future__ import annotations

import unittest

from pcode.kernel.ui import preview_diff


class PreviewDiffTest(unittest.TestCase):
    def test_相同文本无加减行(self) -> None:
        d = preview_diff('a\nb', 'a\nb')
        self.assertNotIn('-a', d)
        self.assertNotIn('+a', d)

    def test_替换显示减旧行与加新行(self) -> None:
        d = preview_diff('old line', 'new line')
        self.assertIn('-old line', d)
        self.assertIn('+new line', d)

    def test_多行修改保留上下文顺序(self) -> None:
        d = preview_diff('a\nb\nc', 'a\nB\nc')
        self.assertIn(' a', d, '公共行保留')
        self.assertIn(' c', d, '公共行保留')
        self.assertIn('-b', d)
        self.assertIn('+B', d)


if __name__ == '__main__':
    unittest.main()
