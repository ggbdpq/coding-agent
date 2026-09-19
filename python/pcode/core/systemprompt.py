"""系统提示词：pcode 身份 + 运行环境 + 指令文件注入 + 技能索引。

注入顺序：~/.pcode/AGENTS.md（全局）在前，项目根 AGENTS.md 在后（后者更具体）。
Skill 约定：~/.pcode/skills/*.md 与 <cwd>/.pcode/skills/*.md 为技能库，
此处只注入"可用技能索引"，正文由 agent 按需用 read 工具读取——最小机制，无加载器。
"""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def _read_if_exists(file: str) -> str | None:
    try:
        if os.path.exists(file):
            with open(file, encoding='utf-8') as f:
                return f.read().strip()
    except OSError:
        pass
    return None


def skill_index(dirs: list[str]) -> str | None:
    """技能索引：列出技能目录中每个 .md 的名字与首行说明（无任何条目返回 None）。"""
    lines: list[str] = []
    for raw_dir in dirs:
        directory = Path(raw_dir).resolve()
        if not directory.is_dir():
            continue
        try:
            entries = os.listdir(directory)
        except OSError:
            continue
        for name in (x for x in entries if x.endswith('.md')):
            full = (directory / name).resolve()
            # 边界自检（规范惯用法）：文件必须位于技能目录之内
            if not str(full).startswith(f'{directory}{os.sep}'):
                continue
            desc = ''
            try:
                first = next(
                    (line for line in full.read_text(encoding='utf-8').split('\n') if line.strip()),
                    '',
                )
                desc = re.sub(r'^#+\s*', '', first)[:60]
            except (OSError, UnicodeDecodeError):
                pass  # 读不了就只列名字
            lines.append(f'- {directory.name}/{full.name}：{desc}（用 read 工具按需读取全文）')
    if not lines:
        return None
    return '\n'.join(['## 可用技能（按需用 read 读取全文）', *lines])


def build_system_prompt(cwd: str) -> str:
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    parts = [
        '你是 pcode，一个直接运行在用户本地终端的极简 coding agent。',
        f'当前工作目录：{cwd}',
        f'操作系统：{sys.platform}；今天日期：{today}',
        '',
        '工作原则：',
        '- 动手改代码前先 read 相关文件，弄清上下文再动手。',
        '- 修改文件用 edit 做精确替换，old_string 必须带足够上下文保证唯一；新文件才用 write。',
        '- 跨文件多处一致的修改用 apply_patch 原子补丁（先全部预验再写入）。',
        '- 修改后用 bash 运行相关测试或命令验证，如实报告结果，绝不谎报通过。',
        '- 找不到文件时先用 glob/grep 定位，不要瞎猜路径。',
        '- 回答用简体中文，简洁直接。',
    ]
    global_md = _read_if_exists(os.path.join(os.path.expanduser('~'), '.pcode', 'AGENTS.md'))
    if global_md:
        parts += ['', '# 用户全局指令（~/.pcode/AGENTS.md）', global_md]
    project_md = _read_if_exists(os.path.join(cwd, 'AGENTS.md'))
    if project_md:
        parts += ['', '# 项目指令（AGENTS.md）', project_md]
    skills = skill_index(
        [
            os.path.join(os.path.expanduser('~'), '.pcode', 'skills'),
            os.path.join(cwd, '.pcode', 'skills'),
        ]
    )
    if skills:
        parts += ['', skills]
    return '\n'.join(parts)
