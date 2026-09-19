"""/approval：查看或修改审批策略（R4）。

normal=写类逐次确认；never=全部免确认。运行时改 config.approval，
并同步会话 yolo 开关让策略立即生效（tcode 无此命令，pcode 按任务规格新增）。
"""
from __future__ import annotations

from pcode.kernel.app import App
from pcode.kernel.plugin import CommandOutcome, CommandPlugin, define_plugin
from pcode.kernel.ui import green, yellow

_POLICY_TEXT = {
    'normal': 'normal（写类操作逐次确认）',
    'never': 'never（全部免确认，等同 --yolo）',
    None: '未设置（默认 normal：写类操作逐次确认）',
}


def _run(app: App, args: list[str]) -> CommandOutcome | None:
    if not args:
        dirs = app.config.allow_write_dirs
        print(f'当前审批策略：{_POLICY_TEXT.get(app.config.approval)}')
        if dirs:
            print(f'写白名单（{len(dirs)} 个目录内的 write/edit 免确认）：')
            for d in dirs:
                print(f'  - {d}')
        else:
            print('写白名单：未配置（可用 config.json 的 allowWriteDirs 或环境变量 PCODE_ALLOW_WRITE）')
        print(yellow('用 /approval normal|never 修改。'))
        return None

    policy = args[0].lower()
    if policy not in ('normal', 'never'):
        print(yellow(f'未知策略：{args[0]}。用法：/approval normal|never'))
        return None

    app.config.approval = policy  # type: ignore[assignment]
    # 策略立即生效：never 等同开启免确认，normal 恢复逐次确认（与会话 yolo 同一开关）
    app.yolo.value = policy == 'never'
    print(green(f'审批策略已改为：{_POLICY_TEXT[policy]}'))
    return None


plugin = define_plugin(
    CommandPlugin(
        name='approval',
        usage='/approval [normal|never]',
        summary='查看或修改审批策略（写类确认/全免）',
        run=_run,
    )
)
