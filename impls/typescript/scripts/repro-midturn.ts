// 用法：复制到 impls/typescript/scripts/repro-midturn.ts，在 impls/typescript 下运行 node scripts/repro-midturn.ts
// 基线 develop@bbac303 的输出见 附录/README.md
// WP2：A 项接入治理中间件（runTurn 直调场景），A1=默认上限（清理足够），
// A2=较小上限（清理不够时观察压缩），照实记录；B/C/D 段保持 WP3/WP4 原样。
import { runTurn } from '../src/core/agentloop.ts';
import { estimateTokens } from '../src/core/trim.ts';
import { createPermissionGate } from '../src/core/permission.ts';
import { governanceMiddleware } from '../src/core/governance.ts';

async function scenarioA(label: string, limit: number) {
  let calls = 0; const peaks: number[] = []; const events: any[] = [];
  const provider = { async chat(messages: any[], _opts: any) {
    if (String(messages[0]?.content ?? '').includes('摘要器')) {
      return { message: { role: 'assistant', content: '这是摘要' } };
    }
    calls++; peaks.push(estimateTokens(messages));
    if (calls <= 8) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c' + calls, type: 'function', function: { name: 'read', arguments: '{"file_path":"big.log"}' } }] } };
    return { message: { role: 'assistant', content: 'done' } };
  } };
  const read = { name: 'read', kind: 'tool', description: '', parameters: {}, needsPermission: false, preview: () => '', run: async () => 'x'.repeat(60_000) } as any;
  const msgs: any[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'analyze' }];
  await runTurn(msgs, {
    provider: provider as any, tools: [read],
    app: { config: { contextLimit: limit }, planMode: { value: false }, store: {} } as any,
    middleware: [governanceMiddleware()],
    onEvent: (e: any) => events.push(e),
  });
  const count = (type: string) => events.filter((e) => e.type === type).length;
  console.log(`A${label}. contextLimit=${limit}，单轮内每次模型请求前的估算 token：`, peaks.join(' → '));
  console.log(`   超过 ${limit} 的请求次数：`, peaks.filter((p) => p > limit).length,
    `| 治理事件：context_edit×${count('context_edit')} compact×${count('compact')} trimmed×${count('trimmed')}`,
    `（${events.map((e) => `${e.type}@${(e as any).at ?? '-'}`).join(' ') || '无'}）`);
}
await scenarioA('1', 100_000);
await scenarioA('2', 50_000);
// B. 截断参数（WP3 后：finishReason='length' 一律不执行，回灌固定话术 + tool_error 事件）
let got: any = 'unset';
const toolErrors: any[] = [];
const write = { name: 'write', kind: 'tool', description: '', parameters: {}, needsPermission: false, preview: () => '', run: async (a: any) => { got = a; return '错误：缺少 file_path'; } } as any;
let n = 0;
const p2 = { async chat() { n++; return n === 1 ? { finishReason: 'length', message: { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: '{"file_path":"src/a.ts","content":"export const' } }] } } : { message: { role: 'assistant', content: 'ok' } }; } };
await runTurn([{ role: 'user', content: 'x' }] as any, { provider: p2 as any, tools: [write], onToolError: (e: any) => toolErrors.push(e) } as any);
console.log('B. finish_reason=length 截断的 tool 参数 → 工具实际收到：', JSON.stringify(got), '| tool_error 事件：', JSON.stringify(toolErrors));
// C. always 的授权粒度
const yolo = { value: false }; const asked: string[] = [];
const gate = createPermissionGate({ ask: async (r) => { asked.push(r.tool); return 'always'; } }, yolo);
await gate('write', 'a.txt'); const r1 = await gate('bash', 'rm -rf build'); 
console.log('C. 对 write 选 always 后，bash 是否还询问：', asked.includes('bash') ? '询问' : '不再询问（全局 yolo）', '放行=', r1);
// D（WP4 合并后启用）：选 scoped 后 bash 仍应询问
// const grants = new Set<string>(); const asked2: string[] = [];
// const gate2 = createPermissionGate({ ask: async (r) => { asked2.push(r.tool); return 'scoped'; } }, { value: false }, grants);
// await gate2('write', 'a.txt', 'write'); await gate2('bash', 'rm -rf build', 'bash:rm');
// console.log('D. 对 write 选 scoped 后，bash 是否还询问：', asked2.includes('bash') ? '询问' : '不再询问');
