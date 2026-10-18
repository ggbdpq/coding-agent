// 工具参数校验（ADR-003/WP3）：非法或被截断的参数不再静默变 {} 去执行工具。
// 零依赖：只校验 JSON 合法性、顶层必须是对象、schema.required 齐全、required
// 字段的顶层 primitive 类型；不做完整 JSON Schema 校验（不引入 ajv/zod）。
import type { FinishReason } from '../kernel/types.ts';

export type ParseResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; kind: 'invalid_args' | 'truncated_args' | 'schema_mismatch'; detail: string };

/** JSON primitive 类型名 → 判定函数（schema 的顶层 primitive 校验只认这几种） */
const PRIMITIVE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
};

/** 参数实际值的简短描述（用于 detail 话术） */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return typeof v;
}

/** schema.required 的字符串列表（schema 来自插件声明，缺省/形态不对时视作空） */
function requiredOf(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
}

/**
 * 工具参数判定（判定表见 工作包/WP3）：
 * 1. finishReason === 'length' → truncated_args（R5：截断时即使 JSON 碰巧合法，
 *    内容也可能只写了一半，一律不执行）；
 * 2. JSON.parse 失败 / 顶层不是对象 → invalid_args；
 * 3. 缺 schema.required 字段或 required 字段 primitive 类型不符 → schema_mismatch。
 */
export function parseToolArgs(
  raw: string | undefined,
  schema: Record<string, unknown>,
  finishReason?: FinishReason
): ParseResult {
  if (finishReason === 'length') {
    return { ok: false, kind: 'truncated_args', detail: '模型响应因 max_tokens 被截断，工具参数不完整' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw && raw.trim() !== '' ? raw : '{}');
  } catch (e) {
    return { ok: false, kind: 'invalid_args', detail: `参数不是合法 JSON（${(e as Error).message}）` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, kind: 'invalid_args', detail: `参数顶层必须是 JSON 对象，实际是 ${describe(parsed)}` };
  }
  const args = parsed as Record<string, unknown>;
  const required = requiredOf(schema);
  const missing = required.filter((key) => !(key in args));
  if (missing.length > 0) {
    return { ok: false, kind: 'schema_mismatch', detail: `缺少必需字段：${missing.join('、')}` };
  }
  const properties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  for (const key of required) {
    const want = properties[key]?.type;
    const check = typeof want === 'string' ? PRIMITIVE_CHECKS[want] : undefined;
    if (check && !check(args[key])) {
      return { ok: false, kind: 'schema_mismatch', detail: `必需字段 ${key} 应为 ${want} 类型，实际是 ${describe(args[key])}` };
    }
  }
  return { ok: true, args };
}

/** 回灌模型的固定话术（spec 锁定）：含工具名、原始参数前 200 字符、必需字段列表、"请重新生成完整参数" */
export function toolArgsErrorText(
  name: string,
  raw: string,
  r: Extract<ParseResult, { ok: false }>,
  schema: Record<string, unknown>
): string {
  const required = requiredOf(schema);
  const fields = required.length > 0 ? required.join('、') : '（无）';
  const preview = raw === '' ? '（空）' : raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return `工具 ${name} 未执行：参数校验失败（${r.kind}：${r.detail}）。原始参数（前 200 字符）：${preview}。必需字段：${fields}。请重新生成完整、合法的参数后重试。`;
}
