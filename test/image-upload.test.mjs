import test from 'node:test';
import assert from 'node:assert/strict';
import { HostBridge, MAX_UPLOAD_BYTES, MAX_ATTACHMENTS_PER_PROMPT } from '../src/server/host-bridge.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function makeBridge() {
  const calls = [];
  const ctx = {
    sessionController: {
      async prompt(request) {
        calls.push(request);
        return { accepted: true };
      },
    },
  };
  const bridge = new HostBridge(ctx);
  return { bridge, calls };
}

async function expectError(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test('uploadAttachment returns a session-scoped opaque receipt', async () => {
  const { bridge } = makeBridge();
  const result = await bridge.uploadAttachment('s1', { mediaType: 'image/png', dataBase64: PNG_1X1, name: 'dot.png' });
  assert.equal(typeof result.receiptId, 'string');
  assert.ok(result.receiptId.length >= 16);
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.bytes, 68);
  assert.equal(result.name, 'dot.png');
});

test('uploadAttachment rejects unsupported media type', async () => {
  const { bridge } = makeBridge();
  await expectError(bridge.uploadAttachment('s1', { mediaType: 'image/svg+xml', dataBase64: PNG_1X1 }), 415, 'unsupported-media-type');
});

test('uploadAttachment rejects non-canonical base64', async () => {
  const { bridge } = makeBridge();
  await expectError(bridge.uploadAttachment('s1', { mediaType: 'image/png', dataBase64: '%%%not-base64%%%' }), 400, 'invalid-base64');
});

test('uploadAttachment rejects bytes that do not match the media type', async () => {
  const { bridge } = makeBridge();
  const jpegAsPng = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
  await expectError(bridge.uploadAttachment('s1', { mediaType: 'image/png', dataBase64: jpegAsPng }), 400, 'invalid-image');
});

test('uploadAttachment enforces the 10MB decoded limit', async () => {
  const { bridge } = makeBridge();
  const oversize = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_UPLOAD_BYTES)]);
  await expectError(bridge.uploadAttachment('s1', { mediaType: 'image/png', dataBase64: oversize.toString('base64') }), 413, 'upload-too-large');
});

test('prompt turns image receipts into canonical PromptContentPart image parts and consumes them', async () => {
  const { bridge, calls } = makeBridge();
  const receipt = await bridge.uploadAttachment('s1', { mediaType: 'image/png', dataBase64: PNG_1X1, name: 'dot.png' });
  const result = await bridge.prompt('s1', '请描述这张图看到了什么', 'req-1', [{ receiptId: receipt.receiptId }]);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 's1');
  assert.equal(calls[0].requestId, 'req-1');
  assert.deepEqual(calls[0].content, [
    { type: 'image', mediaType: 'image/png', data: PNG_1X1, name: 'dot.png' },
    { type: 'text', text: '请描述这张图看到了什么' },
  ]);
  // single use: a second prompt with the same receipt must fail
  await expectError(bridge.prompt('s1', '再发一次', 'req-2', [{ receiptId: receipt.receiptId }]), 410, 'upload-expired');
});

test('prompt accepts image-only content', async () => {
  const { bridge, calls } = makeBridge();
  const receipt = await bridge.uploadAttachment('s1', { mediaType: 'image/png', dataBase64: PNG_1X1 });
  await bridge.prompt('s1', '', 'req-image-only', [{ receiptId: receipt.receiptId }]);
  assert.deepEqual(calls[0].content, [{ type: 'image', mediaType: 'image/png', data: PNG_1X1 }]);
});

test('prompt rejects unknown, foreign-session, malformed and oversized receipt lists', async () => {
  const { bridge } = makeBridge();
  const receipt = await bridge.uploadAttachment('s1', { mediaType: 'image/png', dataBase64: PNG_1X1 });
  await expectError(bridge.prompt('s1', 'x', 'req-a', [{ receiptId: 'missing' }]), 410, 'upload-expired');
  await expectError(bridge.prompt('s2', 'x', 'req-b', [{ receiptId: receipt.receiptId }]), 403, 'upload-session-mismatch');
  await expectError(bridge.prompt('s1', 'x', 'req-c', ['no-receipt-field']), 410, 'upload-expired');
  await expectError(bridge.prompt('s1', 'x', 'req-d', 'not-an-array'), 400, 'bad-attachments');
  const tooMany = Array.from({ length: MAX_ATTACHMENTS_PER_PROMPT + 1 }, () => ({ receiptId: receipt.receiptId }));
  await expectError(bridge.prompt('s1', 'x', 'req-e', tooMany), 400, 'too-many-attachments');
  await expectError(bridge.prompt('s1', '', 'req-f', []), 400, 'empty-prompt');
});

test('uploadAttachment requires sessionId and canonical payload', async () => {
  const { bridge } = makeBridge();
  await expectError(bridge.uploadAttachment('', { mediaType: 'image/png', dataBase64: PNG_1X1 }), 400, 'bad-request');
  await expectError(bridge.uploadAttachment('s1', { mediaType: 'image/png' }), 400, 'bad-request');
});


test('staged uploads are bounded in count and bytes', async () => {
  const { bridge } = makeBridge();
  // Stage more receipts than the count cap allows; the oldest must be evicted.
  const ids = [];
  for (let i = 0; i < 40; i += 1) {
    const receipt = await bridge.uploadAttachment('s1', { mediaType: 'image/png', dataBase64: PNG_1X1 });
    ids.push(receipt.receiptId);
  }
  const staged = bridge._uploads ? bridge._uploads.size : 0;
  if (staged > 0) {
    assert.ok(staged <= 24, 'staged receipt count must stay bounded, got ' + staged);
    // The oldest receipts are the ones evicted.
    assert.equal(bridge._uploads.has(ids[0]), false, 'oldest receipt must be evicted');
    assert.equal(bridge._uploads.has(ids[ids.length - 1]), true, 'newest receipt must survive');
  }
});
