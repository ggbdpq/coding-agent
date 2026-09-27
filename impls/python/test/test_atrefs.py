"""@文件引用解析单测（v0.4-2，镜像 tcode test/atrefs.test.ts）：

输入中的 @path 注入文件内容块，缺文件如实标注缺失而非报错，超长文件截断。
纯函数：读文件经参数注入，方便单测。
"""

import unittest
from typing import Callable

from pcode.core.atrefs import expand_at_refs


def fake_read(files: dict[str, str]) -> Callable[[str], str | None]:
    return lambda p: files.get(p)


class ExpandAtRefsTest(unittest.TestCase):
    def test_无at引用时原样返回(self) -> None:
        self.assertEqual(expand_at_refs('普通输入', fake_read({})), '普通输入')
        # 邮箱里的 @ 不触发引用（@token 前无空白/行首不算）
        self.assertEqual(
            expand_at_refs('邮箱 someone@example.com', fake_read({})),
            '邮箱 someone@example.com',
        )

    def test_at路径替换为文件内容块(self) -> None:
        out = expand_at_refs('看看 @src/a.py 说明了什么', fake_read({'src/a.py': 'hello'}))
        self.assertIn('看看', out, '保留原句')
        self.assertIn('[引用文件 src/a.py]', out, '有引用头')
        self.assertIn('hello', out, '有文件内容')
        self.assertIn('[/引用文件]', out, '有引用尾')

    def test_多个at引用各自注入(self) -> None:
        out = expand_at_refs('@a.txt 和 @b.txt', fake_read({'a.txt': 'AAA', 'b.txt': 'BBB'}))
        self.assertIn('AAA', out)
        self.assertIn('BBB', out)

    def test_文件不存在标注缺失而非报错(self) -> None:
        out = expand_at_refs('看看 @ghost.py', fake_read({}))
        self.assertIn('@ghost.py（文件不存在）', out)

    def test_超长文件截断(self) -> None:
        out = expand_at_refs('看 @big.txt', fake_read({'big.txt': 'x' * 300_000}))
        self.assertLess(len(out), 300_000)
        self.assertIn('已截断', out)

    def test_连续at与行首at都生效(self) -> None:
        out = expand_at_refs('@a.txt', fake_read({'a.txt': 'AAA'}))
        self.assertIn('AAA', out)
        out2 = expand_at_refs('前置@b.txt', fake_read({'b.txt': 'BBB'}))
        # 前面是普通字符（非空白）不展开：与 tcode 的 token 边界一致
        self.assertEqual(out2, '前置@b.txt')


if __name__ == '__main__':
    unittest.main()
