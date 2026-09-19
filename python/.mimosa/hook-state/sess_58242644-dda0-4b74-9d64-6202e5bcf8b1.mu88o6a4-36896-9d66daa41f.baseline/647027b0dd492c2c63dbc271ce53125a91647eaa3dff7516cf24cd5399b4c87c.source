"""会话持久化：JSONL 追加写，一行一条 JSON（meta 行 + message 行）。

/resume 的语义 = 读旧文件、换新文件继续写——避免追加到可能损坏的旧文件。
目录边界：所有读写都限定在会话目录内，出目录一律拒绝/跳过。
"""
from __future__ import annotations

import json
import os
import random
import string
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pcode.kernel.app import SessionSummary
from pcode.kernel.types import ChatMessage

_LABEL_FALLBACK = '(无用户消息)'


class SessionStore:
    def __init__(self, dir_path: str) -> None:
        # 归一化后的会话目录绝对路径
        self._root = str(Path(dir_path).resolve())
        os.makedirs(self._root, exist_ok=True)
        self._file_path: str | None = None

    def _is_inside_dir(self, target: str) -> bool:
        """目录边界校验：目标必须是本目录本身或本目录的直接/间接子路径。"""
        return target == self._root or target.startswith(self._root + os.sep)

    def start(self, meta: dict[str, Any] | None = None) -> None:
        """开新会话文件并写入元信息行。"""
        # Windows 文件名禁 :，把 ISO 时间的冒号一并换掉
        stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%f')[:-3] + 'Z'
        suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
        file = str(Path(self._root, f'{stamp}-{suffix}.jsonl').resolve())
        if not self._is_inside_dir(file):
            raise RuntimeError('会话文件路径越界')
        self._file_path = file
        line = json.dumps(
            {'type': 'meta', 'ts': int(time.time() * 1000), **(meta or {})},
            ensure_ascii=False,
            separators=(',', ':'),
        )
        with open(file, 'a', encoding='utf-8', newline='\n') as f:
            f.write(line + '\n')

    def append(self, message: ChatMessage) -> None:
        """追加一条消息；落盘失败静默（记会话是锦上添花，不该打断对话）。"""
        if self._file_path is None:
            return
        try:
            line = json.dumps(
                {'type': 'message', 'message': message},
                ensure_ascii=False,
                separators=(',', ':'),
            )
            with open(self._file_path, 'a', encoding='utf-8', newline='\n') as f:
                f.write(line + '\n')
        except OSError:
            pass

    def list_recent(self, n: int) -> list[SessionSummary]:
        """最近 n 个会话（排除当前文件），按修改时间倒序。"""
        entries: list[SessionSummary] = []
        for name in os.listdir(self._root):
            if not name.endswith('.jsonl'):
                continue
            file = str(Path(self._root, name).resolve())
            if not self._is_inside_dir(file) or file == self._file_path:
                continue
            entries.append(SessionSummary(file=file, mtime=os.stat(file).st_mtime, label=''))
        entries.sort(key=lambda e: e.mtime, reverse=True)
        entries = entries[:n]
        for entry in entries:
            entry.label = self._read_label(entry.file)
        return entries

    def load(self, file: str) -> list[ChatMessage]:
        """读指定会话文件的全部消息行；越出会话目录的路径一律拒绝。"""
        resolved = str(Path(file).resolve())
        if not self._is_inside_dir(resolved):
            return []
        try:
            with open(resolved, encoding='utf-8') as f:
                lines = f.read().split('\n')
        except OSError:
            return []
        messages: list[ChatMessage] = []
        for line in lines:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue  # 跳过坏行
            if (
                isinstance(obj, dict)
                and obj.get('type') == 'message'
                and isinstance(obj.get('message'), dict)
            ):
                messages.append(obj['message'])
        return messages

    def _read_label(self, file: str) -> str:
        if not self._is_inside_dir(file):
            return _LABEL_FALLBACK
        try:
            with open(file, encoding='utf-8') as f:
                lines = f.read().split('\n')
        except OSError:
            return _LABEL_FALLBACK
        for line in lines:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue  # 跳过坏行
            if not isinstance(obj, dict) or obj.get('type') != 'message':
                continue
            message = obj.get('message')
            if isinstance(message, dict) and message.get('role') == 'user':
                content = message.get('content')
                text = ' '.join((content or '').split())
                if text:
                    return text[:60] or '(空输入)'
        return _LABEL_FALLBACK
