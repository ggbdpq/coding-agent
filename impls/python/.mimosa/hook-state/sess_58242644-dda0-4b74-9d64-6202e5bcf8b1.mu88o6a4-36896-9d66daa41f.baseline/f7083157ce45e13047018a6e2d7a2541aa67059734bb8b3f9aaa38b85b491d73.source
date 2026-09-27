"""写白名单免确认单测（R4，镜像 tcode test/approval.test.ts）：

write/edit 的 skip_permission——目标在 allow_write_dirs 内免确认，
白名单外仍逐次确认，未配置白名单一律确认。bash/web_fetch 不设 skip_permission。
"""

import os
import tempfile
import unittest
from types import SimpleNamespace

from pcode.plugins.tools.edit import plugin as edit_plugin
from pcode.plugins.tools.write import plugin as write_plugin


def fake_app(allow_write_dirs: list[str] | None) -> SimpleNamespace:
    """skip_permission 只认 app.config.allow_write_dirs，测试用最小替身。"""
    config = SimpleNamespace(allow_write_dirs=allow_write_dirs)
    return SimpleNamespace(config=config)


class WriteWhitelistTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp(prefix='pcode-wl-')
        self.addCleanup(os.rmdir, self._tmp)
        self.inside = os.path.join(self._tmp, 'build', 'out.txt')
        self.outside = os.path.join(self._tmp, 'src', 'out.txt')

    def test_路径在白名单目录内免确认(self) -> None:
        app = fake_app([os.path.join(self._tmp, 'build')])
        assert write_plugin.skip_permission is not None
        self.assertTrue(write_plugin.skip_permission({'file_path': self.inside}, app))

    def test_路径在白名单外仍需确认(self) -> None:
        app = fake_app([os.path.join(self._tmp, 'build')])
        assert write_plugin.skip_permission is not None
        self.assertFalse(write_plugin.skip_permission({'file_path': self.outside}, app))

    def test_未配置白名单一律确认(self) -> None:
        app = fake_app(None)
        assert write_plugin.skip_permission is not None
        whatever = os.path.join(self._tmp, 'whatever.txt')
        self.assertFalse(write_plugin.skip_permission({'file_path': whatever}, app))

    def test_空白名单列表同样一律确认(self) -> None:
        app = fake_app([])
        assert write_plugin.skip_permission is not None
        whatever = os.path.join(self._tmp, 'whatever.txt')
        self.assertFalse(write_plugin.skip_permission({'file_path': whatever}, app))

    def test_白名单根目录本身也算在内(self) -> None:
        app = fake_app([os.path.join(self._tmp, 'build')])
        assert write_plugin.skip_permission is not None
        self.assertTrue(write_plugin.skip_permission({'file_path': os.path.join(self._tmp, 'build')}, app))


class EditWhitelistTest(unittest.TestCase):
    def test_白名单内免确认(self) -> None:
        app = fake_app([tempfile.mkdtemp(prefix='pcode-wl-edit-')])
        assert edit_plugin.skip_permission is not None
        target = os.path.join(app.config.allow_write_dirs[0], 'a.py')
        self.assertTrue(edit_plugin.skip_permission({'file_path': target}, app))

    def test_白名单外仍需确认(self) -> None:
        app = fake_app([tempfile.mkdtemp(prefix='pcode-wl-edit2-')])
        assert edit_plugin.skip_permission is not None
        target = os.path.join(tempfile.gettempdir(), 'definitely-not-inside', 'a.py')
        if any(
            target == d or target.startswith(d + os.sep)
            for d in app.config.allow_write_dirs
        ):  # pragma: no cover - 防御极端环境
            self.skipTest('环境目录布局冲突')
        self.assertFalse(edit_plugin.skip_permission({'file_path': target}, app))


class BashWebFetchNoWhitelistTest(unittest.TestCase):
    def test_bash与web_fetch不设skip_permission(self) -> None:
        from pcode.plugins.tools.bash import plugin as bash_plugin
        from pcode.plugins.tools.web_fetch import plugin as web_fetch_plugin

        self.assertIsNone(bash_plugin.skip_permission)
        self.assertIsNone(web_fetch_plugin.skip_permission)


if __name__ == '__main__':
    unittest.main()
