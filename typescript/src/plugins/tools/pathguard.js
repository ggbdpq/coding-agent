// 路径守卫：解析模型给的路径，并标注目标是否越出当前工作目录。
// tcode 的安全边界是权限确认（人工把关），本模块的职责是把越界目标
// 显式带出来，让确认界面能看到 "../" 或绝对路径这类穿越意图，而不是静默放行。
// 非插件，是工具共享的工具函数。
import path from 'node:path';
export function resolvePath(input) {
    const abs = path.resolve(input);
    const rel = path.relative(process.cwd(), abs);
    const outside = rel.startsWith('..') || path.isAbsolute(rel);
    return { abs, outside };
}
