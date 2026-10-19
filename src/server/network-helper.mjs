import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
function getDefaultRouteIfaceNames() {
  const names = new Set();
  try {
    const stdout = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias"
    ], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (stdout) {
      names.add(stdout.toLowerCase());
    }
  } catch {
    // 降级使用特征评分
  }
  return names;
}

/**
 * 获取本地局域网 IPv4 地址列表，私有网段优先，过滤无效与隧道网卡
 */
export function getLocalIPAddresses() {
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
  return out;
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
