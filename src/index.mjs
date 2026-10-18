/**
 * dsh-mobile-remote-control - DeepSeek Harness mobile remote control plugin.
 *
 * Host entry: starts a token-protected LAN HTTP/WS server that exposes the real
 * DSH session services (list, history, follow, prompt, cancel, model switch,
 * workspace changes) to a paired phone. Also serves the loopback pairing API
 * that the desktop client dialog uses.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostBridge } from './server/host-bridge.mjs';
import { RemoteControlServer } from './server/http-server.mjs';
import { ApprovalBridge } from './server/approval-bridge.mjs';
import { QuestionsBridge } from './server/questions-bridge.mjs';

export const name = 'dsh-mobile-remote-control';
export const inject = ['sessionController', 'workspaceRegistry'];

export function apply(ctx, config = {}) {
  const resolved = config || {};
  const bridge = new HostBridge(ctx);
  const server = new RemoteControlServer(bridge);
  const approvalEnabled = resolved.approvalForwarding !== false;
  const approval = new ApprovalBridge({
    ctx,
    isEnabled: () => approvalEnabled,
    timeoutMs: Number(resolved.approvalTimeoutMs) || 40000,
    hasWatcher: (sessionId) => (server.wsHub ? server.wsHub.hasWatcher(sessionId) : false),
    emit: (payload) => {
      if (server.wsHub) server.wsHub.emitApproval(payload);
    },
  });
  const questionsEnabled = resolved.questionForwarding !== false;
  const questions = new QuestionsBridge({
    ctx,
    isEnabled: () => questionsEnabled,
    timeoutMs: Number(resolved.questionTimeoutMs) || 90000,
    hasWatcher: (sessionId) => (server.wsHub ? server.wsHub.hasWatcher(sessionId) : false),
    emit: (payload) => {
      if (server.wsHub) server.wsHub.emitQuestion(payload);
    },
  });
  bridge.forwardingEnabled = approvalEnabled;
  bridge.approvalStats = () => ({
    ...approval.stats,
    pending: approval.pending.size,
    watched: server.wsHub ? server.wsHub.deviceCount : 0,
  });
  bridge.questionsStats = () => ({ ...questions.stats, pending: questions.pending.size });
  bridge.questionsEnabled = questionsEnabled;
  server.approval = approval;
  server.questions = questions;
  approval.install();
  questions.install();

  server.start().catch((error) => {
    console.error('[DSH Remote Control] failed to start pairing server:', error);
  });

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        approval.dispose();
        questions.dispose();
        bridge.dispose();
        server.stop().catch(() => {
          /* shutting down */
        });
      },
      'dsh-mobile-remote-control: LAN server lifecycle',
    );
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { MockBridge } = await import('./server/mock-host.mjs');
  console.log('[DSH Remote Control] Starting standalone MOCK mode (not connected to a DSH Host).');
  console.log('[DSH Remote Control] Use it only for UI integration; the DSH app loads the real Host bridge.');
  const bridge = new MockBridge();
  const server = new RemoteControlServer(bridge);
  await server.start();
  // 日志不落明文 token：只打印主机/端口与 token 指纹，排障足够且不泄露。
  {
    const fingerprint = (await import('node:crypto')).createHash('sha256').update(server.token).digest('hex').slice(0, 8);
    console.log('[DSH Remote Control] Pairing page: http://' + server.lanIp + ':' + server.port + '/  (token fingerprint ' + fingerprint + ')');
  }
  const shutdown = async () => {
    await server.stop();
    bridge.dispose();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
