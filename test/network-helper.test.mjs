// 回归测试：配对地址模块不得在请求路径上同步阻塞。
//
// 背景（真实事故）：getLocalIPAddresses 曾在内部同步执行 powershell.exe 查询默认路由
// （启动开销 0.6–1.5s），导致 /api/desktop/state 每次请求阻塞事件循环 1–3 秒，
// 浏览器 1.2s 探测超时 → 面板报「桌面接口不可用」。修复后必须保证：
//   1) 首次调用在远低于 1s 内返回（缓存未就绪时降级，不等待）
//   2) 连续调用不产生秒级停顿
import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocalIPAddresses, getPrimaryLANIP, getPairingPrimaryIP, generateToken } from '../src/server/network-helper.mjs';

test('first call returns fast without blocking on a route lookup', () => {
  const started = Date.now();
  const ips = getLocalIPAddresses();
  const elapsed = Date.now() - started;
  assert.ok(Array.isArray(ips), 'returns an array');
  assert.ok(elapsed < 1000, 'first call must not block on powershell startup, took ' + elapsed + 'ms');
});

test('repeated calls stay fast (cache hits)', () => {
  const started = Date.now();
  for (let i = 0; i < 20; i += 1) getLocalIPAddresses();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, '20 cached calls must stay fast, took ' + elapsed + 'ms');
});

test('primary ip helpers return a usable address', () => {
  const primary = getPrimaryLANIP();
  const pairing = getPairingPrimaryIP();
  assert.equal(typeof primary, 'string');
  assert.equal(typeof pairing, 'string');
  assert.ok(primary.length > 0 && pairing.length > 0);
});

test('pairing ip prefers Tailscale CGNAT when present', () => {
  const ips = getLocalIPAddresses().map((entry) => entry.address);
  const tailscale = ips.find((ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip));
  const pairing = getPairingPrimaryIP();
  if (tailscale) assert.equal(pairing, tailscale, 'Tailscale address wins when online');
  else assert.equal(pairing, getPrimaryLANIP(), 'falls back to normal primary otherwise');
});

test('generated tokens are high-entropy and unique', () => {
  const a = generateToken();
  const b = generateToken();
  assert.equal(a.length, 64, '32 random bytes hex-encoded');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
