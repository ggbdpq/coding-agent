"""apply_patch 原子补丁单测：全预验通过才写入；任一失败零写入并逐条报告。"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest

from pcode.plugins.tools.apply_patch import plugin


def _read(path: str) -> str:
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


class ApplyPatchTest(unittest.TestCase):
    def _make_files(self) -> tuple[str, str]:
        directory = tempfile.mkdtemp(prefix='pcode-patch-test-')
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        a = os.path.join(directory, 'a.txt')
        b = os.path.join(directory, 'b.txt')
        with open(a, 'w', encoding='utf-8', newline='') as f:
            f.write('alpha\nbeta\n')
        with open(b, 'w', encoding='utf-8', newline='') as f:
            f.write('hello\n')
        return a, b

    def test_全部预验通过_多文件一次应用(self) -> None:
        a, b = self._make_files()
        result = plugin.run(
            {
                'edits': [
                    {'file_path': a, 'old_string': 'alpha', 'new_string': 'ALPHA'},
                    {'file_path': b, 'old_string': 'hello', 'new_string': 'HELLO'},
                ]
            }
        )
        self.assertIn('已应用补丁：2 处编辑', result)
        self.assertEqual(_read(a), 'ALPHA\nbeta\n')
        self.assertEqual(_read(b), 'HELLO\n')

    def test_任一失败_零写入并逐条报告(self) -> None:
        a, b = self._make_files()
        result = plugin.run(
            {
                'edits': [
                    {'file_path': a, 'old_string': 'alpha', 'new_string': 'ALPHA'},
                    {'file_path': b, 'old_string': '不存在的原文', 'new_string': 'X'},
                ]
            }
        )
        self.assertIn('预验未通过', result)
        self.assertIn('未找到 old_string', result)
        self.assertEqual(_read(a), 'alpha\nbeta\n', '失败时 a 不应被改动')
        self.assertEqual(_read(b), 'hello\n')

    def test_多处出现未指定replace_all时拒绝该条(self) -> None:
        a, _ = self._make_files()
        result = plugin.run({'edits': [{'file_path': a, 'old_string': 'a', 'new_string': 'A'}]})
        self.assertIn('出现 3 次', result)
        self.assertEqual(_read(a), 'alpha\nbeta\n')


if __name__ == '__main__':
    unittest.main()
