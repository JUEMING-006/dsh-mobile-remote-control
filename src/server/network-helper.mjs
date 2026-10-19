import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';

// RFC1918 私有网段
const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  // Tailscale/ZeroTier 等 overlay VPN 使用的 CGNAT 段（100.64.0.0/10）
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

// 排除链路本地与代理测试保留段 (169.254.x.x / 198.18.x.x)
const DENY_V4 = [
  /^169\.254\./,
  /^198\.(18|19)\./,
  /^127\./,
  /^0\./,
];

const isUsableV4 = (addr) =>
  PRIVATE_V4.some((r) => r.test(addr)) && !DENY_V4.some((r) => r.test(addr));

// 虚拟网卡与代理隧道网卡正则
const VIRTUAL_REGEX =
  /vethernet|virtual|vmware|hyper-v|tun|tap|wsl|docker|zerotier|tailscale|clash|mihomo|openvpn|wireguard|npcap|loopback|pseudo/i;

function scoreIface(name) {
  const n = String(name).toLowerCase();
  if (VIRTUAL_REGEX.test(n)) return 1;
  if (/wi-?fi|wlan|wireless|无线|airport/i.test(n)) return 100;
  if (/^en\d|^eth\d|ethernet|以太网/i.test(n)) return 80;
  return 50;
}

/**
 * 尝试通过 Windows PowerShell 获取默认路由绑定的出网接口别名
 */
// 默认路由查询要启动 powershell.exe（0.6–1.5s），必须缓存：否则每次状态轮询都会
// 同步阻塞事件循环，手机/面板的 1.2s 探测超时会把服务判为不可用。
let defaultRouteCache = { at: 0, names: null };
const DEFAULT_ROUTE_TTL_MS = 15000;

/**
 * 后台刷新默认路由网卡名。**绝不在请求路径上同步执行** —— powershell.exe 启动要
 * 0.6–1.5s，会阻塞事件循环，让浏览器的 1.2s 探测超时把服务判为不可用。
 * 缓存未就绪时返回空集合，排序会退化为按网卡类型评分（功能可接受）。
 */
let defaultRouteRefreshing = false;
let defaultRouteCacheReady = false;

function refreshDefaultRouteCache() {
  if (defaultRouteRefreshing) return;
  defaultRouteRefreshing = true;
  const snapshotAt = Date.now();
  try {
    execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias",
    ], { encoding: 'utf8', timeout: 4000, windowsHide: true }, (error, stdout) => {
      const names = new Set();
      if (!error && typeof stdout === 'string') {
        const name = stdout.trim().toLowerCase();
        if (name) names.add(name);
      }
      // 即使查询失败也标记就绪：失败结果同样缓存，避免反复重试拖慢系统
      defaultRouteCache = { at: snapshotAt, names };
      defaultRouteCacheReady = true;
      defaultRouteRefreshing = false;
    });
  } catch {
    defaultRouteCache = { at: snapshotAt, names: new Set() };
    defaultRouteCacheReady = true;
    defaultRouteRefreshing = false;
  }
}

function getDefaultRouteIfaceNames() {
  const now = Date.now();
  const fresh = defaultRouteCacheReady && now - defaultRouteCache.at < DEFAULT_ROUTE_TTL_MS;
  if (!fresh) refreshDefaultRouteCache();
  return fresh ? defaultRouteCache.names : new Set();
}

// 模块加载即预热一次：第一个状态请求也能命中缓存
refreshDefaultRouteCache();

/**
 * 获取本地局域网 IPv4 地址列表，私有网段优先，过滤无效与隧道网卡
 */
// 网卡列表缓存：一次状态轮询内多处调用（主 IP 选择 + 备选入口）共享同一份结果
let ifaceCache = { at: 0, value: null };
const IFACE_CACHE_MS = 3000;

export function getLocalIPAddresses() {
  const now = Date.now();
  if (ifaceCache.value && now - ifaceCache.at < IFACE_CACHE_MS) {
    return ifaceCache.value.map((entry) => ({ ...entry }));
  }
  const out = [];
  const viaDefault = getDefaultRouteIfaceNames();

  const interfaces = os.networkInterfaces();
  for (const [name, ifaceList] of Object.entries(interfaces)) {
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      const fam = iface.family === 'IPv4' || iface.family === 4 ? 'IPv4' : iface.family;
      if (fam !== 'IPv4' || iface.internal || !isUsableV4(iface.address)) {
        continue;
      }

      const isDefault = viaDefault.has(name.toLowerCase());
      const priority = (isDefault ? 1000 : 0) + scoreIface(name);

      out.push({
        name,
        address: iface.address,
        priority,
        isDefault,
      });
    }
  }

  out.sort((a, b) => b.priority - a.priority);
  ifaceCache = { at: now, value: out };
  return out.map((entry) => ({ ...entry }));
}

export function getPrimaryLANIP() {
  const ips = getLocalIPAddresses();
  return ips.length > 0 ? ips[0].address : '127.0.0.1';
}

/**
 * 配对主 IP 的自动策略：
 * - Tailscale 在线（存在 100.64/10 地址）时优先它 —— 用户开了 VPN 就是想跨网连，
 *   局域网地址在 AP 隔离下反而不可达。
 * - 否则回落默认行为（默认路由网卡 > WLAN > 以太网）。
 */
export function getPairingPrimaryIP() {
  const ips = getLocalIPAddresses();
  const tailscale = ips.find((entry) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(entry.address));
  if (tailscale) return tailscale.address;
  return ips.length > 0 ? ips[0].address : '127.0.0.1';
}

/**
 * 生成 32 字节高熵十六进制 Token (64 位字符串)
 */
export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}
