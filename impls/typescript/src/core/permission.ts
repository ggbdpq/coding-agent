// 权限闸门：write/edit/bash 等写类操作逐次确认；--yolo / 回答"本会话全部允许"放行整个会话。
// 这是 tcode 的核心安全边界。闸门语义全项目只有这一份：
// 壳（REPL/web）只提供 ask 的 UI 适配，返回 allow/deny/always/scoped 四态决定。
// 按分层规则留在 core：安全边界不开放替换，也不进插件注册表。
// WP4：新增第四态 scoped（"本会话允许此类"）——按授权键的会话内记忆，进程内
// Set<grantKey>、不持久化；always（R3 契约：进程内全局布尔）语义不变。
import type { YoloRef } from '../kernel/types.ts';

export type PermissionDecision = 'allow' | 'deny' | 'always' | 'scoped';

export interface PermissionRequest {
  tool: string;
  preview: string;
  /** 授权键：scoped 决定按它记忆粒度；为空 = 不可 scoped（如复合 bash 命令），壳不显示该选项 */
  grantKey?: string;
  /** 给 UI 的 scoped 选项文案，例如"本会话允许所有 edit"/"本会话允许 npm 命令" */
  grantLabel?: string;
}

export interface PermissionIO {
  ask: (req: PermissionRequest) => Promise<PermissionDecision>;
}

/** 授权键 → scoped 选项文案（WP4 表格）：`bash:npm` → "本会话允许 npm 命令"，其余 → "本会话允许所有 <键>" */
function grantLabelFor(grantKey: string): string {
  return grantKey.startsWith('bash:')
    ? `本会话允许 ${grantKey.slice('bash:'.length)} 命令`
    : `本会话允许所有 ${grantKey}`;
}

export function createPermissionGate(
  io: PermissionIO,
  yoloRef: YoloRef,
  grants?: Set<string>
): (toolName: string, preview: string, grantKey?: string) => Promise<boolean> {
  return async (toolName, preview, grantKey) => {
    if (yoloRef.value) return true;
    if (grantKey && grants?.has(grantKey)) return true;
    const decision = await io.ask({
      tool: toolName,
      preview,
      // grantKey 为空 = 不可 scoped，请求不带键，壳保持原三档
      ...(grantKey ? { grantKey, grantLabel: grantLabelFor(grantKey) } : {}),
    });
    if (decision === 'always') yoloRef.value = true;
    if (decision === 'scoped' && grantKey) grants?.add(grantKey);
    return decision !== 'deny';
  };
}
