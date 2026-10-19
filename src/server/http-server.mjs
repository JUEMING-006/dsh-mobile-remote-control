import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { getPrimaryLANIP, getPairingPrimaryIP, getLocalIPAddresses, generateToken } from './network-helper.mjs';
import { WsHub } from './ws-hub.mjs';
import { MAX_UPLOAD_BYTES } from './host-bridge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_WEB_ROOT = path.resolve(__dirname, '../web');

const STATIC_FILES = {
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/mock.js': { file: 'mock.js', type: 'text/javascript; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
};

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

/** Read a raw binary request body with a hard byte limit. */
function readRawBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      // Do NOT destroy the socket here: the caller still has to write a 413 body.
      // Destroying first is what turned oversize uploads into ECONNRESET on the phone.
      req.pause();
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(Object.assign(new Error('request aborted'), { statusCode: 400 })));
  });
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        // Respond 413 instead of resetting the connection (see readRawBody).
        settled = true;
        req.pause();
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('request aborted'), { statusCode: 400 })));
  });
}

/**
 * LAN HTTP + WebSocket server for the paired mobile client, plus the loopback
 * pairing API used by the desktop client plugin.
 */
export class RemoteControlServer {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.port = options.port || 52880;
    this.fixedToken = options.token || null;
    this.host = options.host || '0.0.0.0';
    this.webRoot = options.webRoot || DEFAULT_WEB_ROOT;
    this.token = this.fixedToken || generateToken();
    this.state = 'stopped';
    this.lanIp = '127.0.0.1';
    this.qrDataUrl = null;
    this.server = null;
    this.wsHub = null;
    this.isRunning = false;
    this.startedAt = Date.now();
    this.webHtml = null;
    this.lastQrAt = 0;
    this.approval = null;
    this.questions = null;
  }

  get version() {
    return this.bridge.version || '2.0.0';
  }

  get deviceCount() {
    return this.wsHub ? this.wsHub.deviceCount : 0;
  }

  getPairingUrl() {
    return 'http://' + this.lanIp + ':' + this.port + '/?token=' + this.token;
  }

  async refreshQRCode() {
    this.lanIp = getPrimaryLANIP();
    if (!this.fixedToken) this.token = generateToken();
    const url = this.getPairingUrl();
    this.qrDataUrl = await QRCode.toDataURL(url, {
      width: 360,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a0a0a', light: '#ffffff' },
    });
    this.lastQrAt = Date.now();
    this.state = 'ready';
    if (this.wsHub) this.wsHub.revokeAllClients(4001, 'pairing token refreshed');
    return { url, qrDataUrl: this.qrDataUrl };
  }

  stopPairing() {
    this.state = 'stopped';
    if (this.wsHub) this.wsHub.revokeAllClients(4001, 'remote control stopped');
    return this.desktopState();
  }

  desktopState() {
    // 主配对 IP 自动跟随网络变化（如刚打开 Tailscale）：下一次面板轮询（2s）即自动
    // 切换到新地址并重绘二维码，无需手动「刷新二维码」。token 不轮换，已连接的
    // 手机不会被踢。备选入口列出其余网卡的配对 URL。
    const preferredIp = getPairingPrimaryIP();
    if (preferredIp && preferredIp !== '127.0.0.1' && preferredIp !== this.lanIp) {
      this.lanIp = preferredIp;
      QRCode.toDataURL(this.getPairingUrl(), {
        width: 360,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0a0a0a', light: '#ffffff' },
      }).then((dataUrl) => {
        this.qrDataUrl = dataUrl;
        this.lastQrAt = Date.now();
      }).catch(() => {});
    }
    const altUrls = getLocalIPAddresses()
      .map((entry) => entry.address)
      .filter((ip) => ip !== this.lanIp)
      .map((ip) => 'http://' + ip + ':' + this.port + '/?token=' + this.token);
    return {
      state: this.state,
      ready: this.state === 'ready',
      lanIp: this.lanIp,
      port: this.port,
      pairingUrl: this.getPairingUrl(),
      altUrls,
      qrDataUrl: this.qrDataUrl,
      deviceCount: this.deviceCount,
      version: this.version,
      protocol: 1,
      mode: this.bridge.mode || 'host',
    };
  }

  isTokenValid(token) {
    if (!token) return false;
    try {
      return crypto.timingSafeEqual(sha256(token), sha256(this.token));
    } catch {
      return false;
    }
  }

  isLoopback(req) {
    const remote = req.socket && req.socket.remoteAddress;
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  }

  cors(res, allowAll = false) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (allowAll) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Remote-Token, X-Requested-With');
    }
  }

  json(res, statusCode, payload, allowAll = false) {
    this.cors(res, allowAll);
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  getMobileToken(req, url) {
    const headerToken = req.headers['x-remote-token'];
    if (typeof headerToken === 'string' && headerToken) return headerToken;
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
    return url.searchParams.get('token');
  }

  mobileAuthorized(req, url) {
    return this.isTokenValid(this.getMobileToken(req, url));
  }

  serveIndex(res) {
    let html = null;
    try {
      html = fs.readFileSync(path.join(this.webRoot, 'index.html'), 'utf8');
    } catch {
      html = '<!doctype html><html lang="zh-CN"><body style="font-family:system-ui;padding:24px"><h1>DSH 远程控制</h1><p>移动端资源尚未构建：缺少 src/web/index.html。</p></body></html>';
    }
    this.cors(res);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    res.end(html);
  }

  serveStatic(res, entry) {
    try {
      const body = fs.readFileSync(path.join(this.webRoot, entry.file));
      this.cors(res);
      res.writeHead(200, { 'Content-Type': entry.type });
      res.end(body);
    } catch {
      this.json(res, 404, { error: 'not found' });
    }
  }

  async start() {
    if (this.isRunning) return;
    await this.refreshQRCode();

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        try {
          if (!res.headersSent) this.json(res, error.statusCode || 500, { error: error.message || String(error) });
          else res.end();
        } catch {
          /* ignore */
        }
      });
    });

    let bound = false;
    let lastError = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            this.server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            this.server.off('error', onError);
            resolve();
          };
          this.server.once('error', onError);
          this.server.once('listening', onListening);
          this.server.listen(this.port, this.host);
        });
        bound = true;
        break;
      } catch (error) {
        lastError = error;
        if (error && error.code === 'EADDRINUSE') {
          this.port += 1;
          continue;
        }
        throw error;
      }
    }
    if (!bound) throw lastError || new Error('failed to bind server');

    this.wsHub = new WsHub(this.server, this.bridge, {
      getState: () => this.state,
      getToken: () => this.token,
      isTokenValid: (token) => this.isTokenValid(token),
    }, this.approval || null, this.questions || null);
    this.isRunning = true;
    this.state = 'ready';
    await this.refreshQRCode();
    console.log('[DSH Remote Control] Listening on http://0.0.0.0:' + this.port);
    const fingerprint = crypto.createHash('sha256').update(this.token).digest('hex').slice(0, 8);
    console.log('[DSH Remote Control] Pairing page: http://' + this.lanIp + ':' + this.port + '/  (token fingerprint ' + fingerprint + ')');
  }

  async handle(req, res) {
    const host = req.headers.host || '127.0.0.1';
    const url = new URL(req.url || '/', 'http://' + host);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      // Preflight: allow every own API route from any browser origin. The pairing token
      // is still required on the actual request, so this grants no access by itself.
      this.cors(res, pathname.startsWith('/api/'));
      res.writeHead(204);
      res.end();
      return;
    }

    // ── public ────────────────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/index.html') {
      this.serveIndex(res);
      return;
    }
    const staticEntry = STATIC_FILES[pathname];
    if (staticEntry) {
      this.serveStatic(res, staticEntry);
      return;
    }
    if (pathname === '/api/health') {
      this.json(res, 200, {
        ok: true,
        version: this.version,
        mode: this.bridge.mode || 'host',
        startedAt: this.startedAt,
        state: this.state,
      }, true);
      return;
    }

    // ── desktop pairing API (loopback only) ───────────────────────────────
    const isDesktopRoute =
      pathname === '/api/desktop/state' ||
      pathname === '/api/desktop/refresh' ||
      pathname === '/api/desktop/stop' ||
      pathname === '/api/status' ||
      pathname === '/api/qr' ||
      pathname === '/api/refresh-qr';
    if (isDesktopRoute) {
      if (!this.isLoopback(req)) {
        this.json(res, 403, { error: 'loopback only' }, true);
        return;
      }
      if (pathname === '/api/desktop/state') {
        this.json(res, 200, this.desktopState(), true);
        return;
      }
      if (pathname === '/api/desktop/refresh' && req.method === 'POST') {
        await this.refreshQRCode();
        this.json(res, 200, this.desktopState(), true);
        return;
      }
      if (pathname === '/api/desktop/stop' && req.method === 'POST') {
        this.json(res, 200, this.stopPairing(), true);
        return;
      }
      // legacy aliases used by the previously installed desktop bundle
      if ((pathname === '/api/status' && req.method === 'GET') || (pathname === '/api/qr' && req.method === 'GET')) {
        this.json(res, 200, this.desktopState(), true);
        return;
      }
      if (pathname === '/api/refresh-qr' && req.method === 'POST') {
        await this.refreshQRCode();
        this.json(res, 200, { url: this.getPairingUrl(), qrDataUrl: this.qrDataUrl }, true);
        return;
      }
      this.json(res, 404, { error: 'not found' }, true);
      return;
    }

    // ── mobile API (token required) ───────────────────────────────────────
    if (pathname.startsWith('/api/')) {
      // Browser origins need CORS to call the paired API (e.g. the DSH web shell during
      // verification, or a future same-device PWA). The pairing token remains the auth,
      // so exposing ACAO here does not widen access to anyone without the token.
      this.cors(res, true);
      if (pathname === '/api/health') { /* unreachable: handled above */ }
      if (this.state !== 'ready') {
        this.json(res, 403, { error: 'stopped', message: '远程控制已在电脑端停止，请重新扫码连接' });
        return;
      }
      if (!this.mobileAuthorized(req, url)) {
        this.json(res, 401, { error: 'unauthorized', message: '配对令牌无效或已刷新，请重新扫码' });
        return;
      }

      if (pathname === '/api/bootstrap' && req.method === 'GET') {
        const bootstrap = await this.bridge.getBootstrap();
        this.json(res, 200, { ...bootstrap, deviceCount: this.deviceCount });
        return;
      }
      if (pathname === '/api/models' && req.method === 'GET') {
        this.json(res, 200, await this.bridge.getModels(true));
        return;
      }
      if (pathname === '/api/account' && req.method === 'GET') {
        this.json(res, 200, await this.bridge.getAccount());
        return;
      }
      if (pathname === '/api/plugins' && req.method === 'GET') {
        this.json(res, 200, await this.bridge.getPlugins());
        return;
      }
      if (pathname === '/api/search' && req.method === 'GET') {
        this.json(res, 200, await this.bridge.search(url.searchParams.get('q') || ''));
        return;
      }
      if (pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        this.json(res, 200, await this.bridge.createSession({ workspaceId: body.workspaceId, cwd: body.cwd, agentPreset: body.agentPreset }));
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const rest = sessionMatch[2] || '';
        if (!rest && req.method === 'GET') {
          this.json(res, 200, await this.bridge.getSessionDetail(sessionId));
          return;
        }
        if (rest === 'history' && req.method === 'GET') {
          const page = await this.bridge.getMessages(sessionId, {
            beforeSeq: Number(url.searchParams.get('beforeSeq')) || undefined,
            maxMessages: Number(url.searchParams.get('maxMessages')) || undefined,
          });
          this.json(res, 200, page);
          return;
        }
        if (rest === 'changes' && req.method === 'GET') {
          const seq = Number(url.searchParams.get('seq'));
          this.json(res, 200, { summary: this.bridge.getChanges(sessionId, seq) });
          return;
        }
        const diffMatch = rest.match(/^changes\/(\d+)\/(\d+)$/);
        if (diffMatch && req.method === 'GET') {
          const diff = await this.bridge.getDiff(sessionId, Number(diffMatch[1]), Number(diffMatch[2]));
          this.json(res, 200, { diff });
          return;
        }
        const attachmentMatch = rest.match(/^attachment\/(.+)$/);
        if (attachmentMatch && req.method === 'GET') {
          const attachment = await this.bridge.getAttachment(sessionId, decodeURIComponent(attachmentMatch[1]));
          this.json(res, 200, attachment);
          return;
        }
        if (rest === 'upload' && req.method === 'POST') {
          const contentType = String(req.headers['content-type'] || '').toLowerCase();
          let attachments;
          if (contentType.startsWith('image/')) {
            // Raw binary carrier: Content-Type image/*, optional ?name=.
            const buffer = await readRawBody(req, MAX_UPLOAD_BYTES);
            attachments = {
              mediaType: contentType.split(';', 1)[0].trim(),
              dataBase64: buffer.toString('base64'),
              name: url.searchParams.get('name') || undefined,
            };
          } else {
            // JSON base64 carrier used by the phone client.
            const body = await readBody(req, Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 64 * 1024);
            attachments = { mediaType: body.mediaType, dataBase64: body.dataBase64 || body.data, name: body.name };
          }
          this.json(res, 200, await this.bridge.uploadAttachment(sessionId, attachments));
          return;
        }
        if (rest === 'prompt' && req.method === 'POST') {
          const body = await readBody(req);
          this.json(res, 200, await this.bridge.prompt(sessionId, body.text, body.requestId, body.attachments));
          return;
        }
        if (rest === 'cancel' && req.method === 'POST') {
          this.json(res, 200, await this.bridge.cancel(sessionId));
          return;
        }
        if ((rest === 'model' || rest === 'select-model') && req.method === 'POST') {
          const body = await readBody(req);
          this.json(res, 200, await this.bridge.selectModel(sessionId, body.provider, body.model, body.reasoningEffort));
          return;
        }
        if (rest === 'rename' && req.method === 'POST') {
          const body = await readBody(req);
          this.json(res, 200, await this.bridge.rename(sessionId, body.title));
          return;
        }
      }
      this.json(res, 404, { error: 'not found' });
      return;
    }

    this.json(res, 404, { error: 'not found' });
  }

  async stop() {
    if (this.wsHub) {
      await this.wsHub.close();
      this.wsHub = null;
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    this.isRunning = false;
    this.state = 'stopped';
  }
}
