"""rg 工具函数：glob/grep 两个工具共用。约定退出码：0 有匹配、1 无匹配、≥2 出错。"""
from __future__ import annotations

import os
import subprocess
import sys
from typing import Any

_CREATE_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def run_rg(rg_args: list[str], cap: int = 8000) -> str:
    popen_kwargs: dict[str, Any] = dict(
        cwd=os.getcwd(), stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    if sys.platform == 'win32':
        popen_kwargs['creationflags'] = _CREATE_NO_WINDOW
    try:
        proc = subprocess.Popen(['rg', *rg_args], **popen_kwargs)
    except OSError as e:
        return f'错误：无法启动 rg（{e}）。本工具依赖 ripgrep，请先安装。'
    out, err = proc.communicate()
    out_text = out.decode('utf-8', errors='replace')
    err_text = err.decode('utf-8', errors='replace')
    code = proc.returncode
    if code == 1 and not err_text.strip():
        return '无匹配'
    if code is not None and code > 1:
        return f'错误：rg 退出码 {code}：{err_text.strip()[:500]}'
    if len(out_text) > cap:
        out_text = out_text[:cap] + '\n…（结果超长已截断）'
    return out_text.rstrip('\n') or '无匹配'
