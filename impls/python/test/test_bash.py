"""bash 超时：必须连同 shell 起的子进程一起杀掉，并及时返回。"""

import os
import sys
import tempfile
import time
import unittest

from pcode.plugins.tools.bash import _run


@unittest.skipIf(sys.platform == 'win32', 'Windows 走 taskkill /T 分支')
class BashTimeoutTest(unittest.TestCase):
    def test_超时杀掉整个进程组(self) -> None:
        with tempfile.TemporaryDirectory(prefix='pcode-bash-') as tmp:
            pid_file = os.path.join(tmp, 'pid')
            start = time.monotonic()
            out = _run({'command': f'sleep 30 & echo $! > {pid_file}; wait', 'timeout_sec': 1})
            elapsed = time.monotonic() - start

            self.assertIn('exit=timeout', out)
            self.assertLess(elapsed, 3, f'超时后应及时返回，实际 {elapsed:.1f}s')

            with open(pid_file, encoding='utf-8') as f:
                pid = int(f.read())
            alive = True
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                alive = False
            if alive:
                os.kill(pid, 9)
            self.assertFalse(alive, f'孙进程 {pid} 在超时后仍存活')


if __name__ == '__main__':
    unittest.main()
