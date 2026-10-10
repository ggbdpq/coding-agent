"""路径守卫越界判定：工作目录里的符号链接指向外部时，必须按链接的真实目标算（对齐 Go 版 TestPathGuardFollowsSymlinks）。"""

import os
import tempfile
import unittest

from pcode.plugins.tools.pathguard import resolve_path


class ResolvePathOutsideTest(unittest.TestCase):
    def setUp(self) -> None:
        work = tempfile.TemporaryDirectory(prefix='pcode-pg-work-')
        outside = tempfile.TemporaryDirectory(prefix='pcode-pg-out-')
        self.addCleanup(work.cleanup)
        self.addCleanup(outside.cleanup)
        try:
            os.symlink(outside.name, os.path.join(work.name, 'link'))
            os.symlink(os.path.join(outside.name, 'not-yet.txt'), os.path.join(work.name, 'dangling'))
        except OSError as e:
            self.skipTest(f'无法创建符号链接: {e}')
        os.mkdir(os.path.join(work.name, '..foo'))
        old = os.getcwd()
        os.chdir(work.name)
        self.addCleanup(os.chdir, old)

    def test_越界判定(self) -> None:
        cases = [
            ('plain.txt', False),
            ('sub/new.txt', False),
            ('..foo/a.txt', False),
            ('../x.txt', True),
            ('link/x.txt', True),
            ('dangling', True),
        ]
        for path, want in cases:
            with self.subTest(path=path):
                self.assertEqual(resolve_path(path).outside, want)

    def test_abs_保持未解析的原路径(self) -> None:
        self.assertEqual(resolve_path('link/x.txt').abs, os.path.abspath('link/x.txt'))


if __name__ == '__main__':
    unittest.main()
