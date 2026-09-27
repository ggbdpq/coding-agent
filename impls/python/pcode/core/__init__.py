"""core 层：agent loop、一轮编排、上下文裁剪、会话、权限、系统提示词。

依赖方向：core 只 import kernel，不 import providers/plugins/shell。
"""
