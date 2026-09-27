// 权限闸门：write/edit/bash 等写类操作逐次确认；--yolo / 回答"本会话全部允许"放行整个会话。
// 这是 tcode 的核心安全边界。闸门语义全项目只有这一份：
// 壳（REPL/web）只提供 ask 的 UI 适配，返回 allow/deny/always 三态决定。
// 按分层规则留在 core：安全边界不开放替换，也不进插件注册表。
import type { YoloRef } from '../kernel/types.ts';

export type PermissionDecision = 'allow' | 'deny' | 'always';

export interface PermissionRequest {
  tool: string;
  preview: string;
}

export interface PermissionIO {
  ask: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export function createPermissionGate(
  io: PermissionIO,
  yoloRef: YoloRef
): (toolName: string, preview: string) => Promise<boolean> {
  return async (toolName, preview) => {
    if (yoloRef.value) return true;
    const decision = await io.ask({ tool: toolName, preview });
    if (decision === 'always') yoloRef.value = true;
    return decision !== 'deny';
  };
}
