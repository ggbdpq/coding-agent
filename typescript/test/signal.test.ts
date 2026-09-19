// 取消贯穿工具单测：AbortSignal 传入 tool.run 后必须能杀掉失控子进程（蓝图 R2/G2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import bashTool from '../src/plugins/tools/bash.ts';
import webFetchTool from '../src/plugins/tools/webfetch.ts';

test('bash 工具：abort 后快速终止长命令', async () => {
  const controller = new AbortController();
  const t0 = Date.now();
  const run = bashTool.run({ command: 'sleep 30' }, controller.signal);
  setTimeout(() => controller.abort(), 300);
  const result = await run;
  const ms = Date.now() - t0;
  assert.ok(ms < 10_000, `应在数秒内被杀（实际 ${ms}ms）`);
  assert.match(result, /exit=/, '应返回 exit 报告');
});

test('web_fetch 工具：abort 中断挂起的抓取', async () => {
  const controller = new AbortController();
  const t0 = Date.now();
  // 203.0.113.1 是 RFC 5737 文档地址（可路由策略上黑洞），netguard 放行、fetch 挂起，
  // abort 必须走在 20s 超时前面返回。
  const run = webFetchTool.run({ url: 'http://203.0.113.1/hang' }, controller.signal);
  setTimeout(() => controller.abort(), 300);
  const result = await run;
  const ms = Date.now() - t0;
  assert.ok(ms < 10_000, `应在数秒内返回（实际 ${ms}ms）：${result.slice(0, 80)}`);
});
