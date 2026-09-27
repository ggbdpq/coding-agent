"""bash 工具：子进程执行命令，输出封顶、超时强杀。

win32 优先用 Git Bash（模型常发 unix 命令），只认显式路径，避免误中 System32 的 WSL bash；
都没有就退回 cmd。安全边界：执行前经权限确认，确认界面展示完整命令。
同步阻塞模型：读输出用后台线程封顶累积（防止失控输出撑爆内存），wait() 带超时。
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
from typing import Any

from pcode.kernel.plugin import ToolPlugin, define_plugin

MAX_OUTPUT = 64 * 1024
DEFAULT_TIMEOUT_SEC = 120
MAX_TIMEOUT_SEC = 600
_CREATE_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _resolve_shell() -> tuple[str, list[str]]:
    if sys.platform == 'win32':
        candidates = [os.environ.get('PCODE_BASH'), r'C:\Program Files\Git\bin\bash.exe']
        for candidate in candidates:
            if candidate and os.path.exists(candidate):
                return candidate, ['-c']
        return os.environ.get('COMSPEC', 'cmd.exe'), ['/d', '/s', '/c']
    return '/bin/bash', ['-c']


def _preview(args: dict[str, Any]) -> str:
    return f'执行命令（cwd={os.getcwd()}）\n$ {args.get("command")}'


def _pump(pipe: Any, sink: list[bytes]) -> None:
    """逐块读子进程输出，超过 MAX_OUTPUT 的部分丢弃不累积（管道保持排空，不会堵死子进程）。"""
    received = 0
    try:
        while True:
            chunk = pipe.read(4096)
            if not chunk:
                break
            room = MAX_OUTPUT - received
            if room > 0:
                keep = chunk[:room]
                sink.append(keep)
                received += len(keep)
    except (OSError, ValueError):
        pass
    finally:
        try:
            pipe.close()
        except OSError:
            pass


def _run(args: dict[str, Any]) -> str:
    command = str(args.get('command') or '')
    if not command.strip():
        return '错误：缺少 command'
    timeout_sec = max(1, min(_to_int(args.get('timeout_sec'), DEFAULT_TIMEOUT_SEC), MAX_TIMEOUT_SEC))
    shell_file, shell_args = _resolve_shell()

    popen_kwargs: dict[str, Any] = dict(
        cwd=os.getcwd(), stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    if sys.platform == 'win32':
        popen_kwargs['creationflags'] = _CREATE_NO_WINDOW
    try:
        proc = subprocess.Popen([shell_file, *shell_args, command], **popen_kwargs)
    except OSError as e:
        return f'错误：无法启动 shell（{e}）'

    out_parts: list[bytes] = []
    err_parts: list[bytes] = []
    threads = [
        threading.Thread(target=_pump, args=(proc.stdout, out_parts), daemon=True),
        threading.Thread(target=_pump, args=(proc.stderr, err_parts), daemon=True),
    ]
    for t in threads:
        t.start()

    timed_out = False
    try:
        proc.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        timed_out = True
        if sys.platform == 'win32':
            # Windows 上 kill 杀不掉子进程树，用 taskkill 连坐
            subprocess.run(
                ['taskkill', '/pid', str(proc.pid), '/T', '/F'],
                capture_output=True,
                creationflags=_CREATE_NO_WINDOW,
            )
        else:
            proc.kill()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
    for t in threads:
        t.join(timeout=2)

    def _cap(s: str) -> str:
        if len(s) >= MAX_OUTPUT:
            return s[:MAX_OUTPUT] + '\n…（输出超长已截断）'
        return s

    out = b''.join(out_parts).decode('utf-8', errors='replace')
    err = b''.join(err_parts).decode('utf-8', errors='replace')
    if timed_out:
        exit_part = f'timeout（{timeout_sec}s 超时强制终止）'
    elif proc.returncode is not None and proc.returncode < 0:
        exit_part = f'signal:{-proc.returncode}'  # POSIX 负返回码 = 被信号杀死
    else:
        exit_part = str(proc.returncode)
    parts = [f'exit={exit_part}']
    if out.strip():
        parts.append(f'--- stdout ---\n{_cap(out).rstrip()}')
    if err.strip():
        parts.append(f'--- stderr ---\n{_cap(err).rstrip()}')
    return '\n'.join(parts)


plugin = define_plugin(
    ToolPlugin(
        name='bash',
        kind='tool',
        description='在当前目录执行 shell 命令并返回退出码与输出。用于跑测试、构建、git 等验证操作；输出超长会被截断。',
        parameters={
            'type': 'object',
            'properties': {
                'command': {'type': 'string', 'description': '要执行的命令'},
                'timeout_sec': {
                    'type': 'number',
                    'description': f'超时秒数，默认 {DEFAULT_TIMEOUT_SEC}，上限 {MAX_TIMEOUT_SEC}',
                },
            },
            'required': ['command'],
        },
        needs_permission=True,
        preview=_preview,
        run=_run,
    )
)
