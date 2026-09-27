// 网络守卫单测：SSRF 防线的判定表，逐条锁死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUrlLiteral, isPublicIPv4, isPublicIPv6 } from '../src/plugins/tools/netguard.ts';

function blocked(raw: string): boolean {
  return !checkUrlLiteral(raw).ok;
}

test('协议白名单：仅 http/https', () => {
  assert.ok(blocked('ftp://example.com/x'));
  assert.ok(blocked('file:///etc/passwd'));
  assert.ok(!blocked('https://example.com/x'));
  assert.ok(!blocked('http://example.com/x'));
});

test('保留域名与字面内网 IP 一律拒绝', () => {
  for (const raw of [
    'http://localhost/x',
    'http://api.localhost/x',
    'http://svc.internal/x',
    'http://127.0.0.1/x',
    'http://10.0.0.1/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://169.254.169.254/meta', // 云元数据端点
    'http://0.0.0.0/x',
    'http://[::1]/x',
    'http://[fd00::1]/x',
  ]) {
    assert.ok(blocked(raw), `${raw} 应被拒绝`);
  }
});

test('公网地址放行、坏 URL 拒绝', () => {
  assert.ok(!blocked('https://api.deepseek.com/v1'));
  assert.ok(!blocked('http://8.8.8.8/dns-query'));
  assert.ok(!blocked('http://[2606:4700::1111]/x'));
  assert.ok(blocked('not a url'));
  // http:///no-host 会被 URL 解析成普通域名 no-host：字面层放行，由 DNS 复检兜底
  assert.ok(!blocked('http:///no-host'));
});

test('isPublicIPv4 判定表', () => {
  assert.equal(isPublicIPv4('8.8.8.8'), true);
  assert.equal(isPublicIPv4('172.32.0.1'), true); // 172 段只有 16-31 是私有
  assert.equal(isPublicIPv4('172.16.0.1'), false);
  assert.equal(isPublicIPv4('100.64.0.1'), false); // CGNAT
  assert.equal(isPublicIPv4('198.18.0.1'), false); // 基准测试
  assert.equal(isPublicIPv4('224.0.0.1'), false); // 组播
  assert.equal(isPublicIPv4('256.1.1.1'), false); // 非法
});

test('isPublicIPv6 判定表（含 IPv4 映射回拆）', () => {
  assert.equal(isPublicIPv6('2606:4700::1111'), true);
  assert.equal(isPublicIPv6('::ffff:8.8.8.8'), true);
  assert.equal(isPublicIPv6('::ffff:192.168.0.1'), false); // 映射的私网 v4
  assert.equal(isPublicIPv6('::1'), false);
  assert.equal(isPublicIPv6('fe80::1'), false);
  assert.equal(isPublicIPv6('fc00::1'), false);
  assert.equal(isPublicIPv6('fd12::1'), false);
});
