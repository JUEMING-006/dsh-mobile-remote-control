#!/usr/bin/env node
// E2E runner for the mobile remote-control plugin (verify instance).
// Requires the second DSH instance to be running (see .verify/start-verify.mjs).
//
// Usage:
//   node test/e2e/run.mjs [--url <plugin page url>] [--write] [--out <dir>] [--headed] [--keep-session]
//
// Target URL resolution order: --url, $VERIFY_URL, .verify/VERIFY_URL (token refreshed via .verify/token.mjs).
// Steps: health -> bootstrap -> session history (REST) -> task list DOM -> open session -> message DOM
//        -> model sheet -> settings view -> screenshots. With --write: send short message -> interrupt
//        -> switch model (only on the scratch session recorded in .verify/E2E_SESSION_ID when possible).
// Missing/unimplemented UI hooks are reported as SKIP with an explicit reason; nothing is silently PASS.
//
// UI contract (new src/web/app.js):
//   task list item:  .task-card[data-action="open-session"][data-id="<sessionId>"]
//   message item:    .msg[data-mid]
//   composer input:  #composer-input
//   send/stop:       #send-btn  (class "stopping" while the turn runs; clicking cancels)
//   model pill:      [data-action="open-model-sheet"]
//   model row:       .model-row-btn[data-action="select-model-row"]
//   settings link:   [data-action="open-model-settings"]
//   settings view:   .settings-view
//   chat back:       [data-action="chat-back"]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, sleep } from '../../.verify/cdp.mjs';
import { resolveTarget } from '../../.verify/token.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(repoRoot, 'artifacts', 'after');

const UI = {
  taskCard: '.task-card[data-action="open-session"]',
  message: '.msg[data-mid]',
  userMessage: '.msg-user[data-mid]',
  composer: '#composer-input',
  sendBtn: '#send-btn',
  modelPill: '[data-action="open-model-sheet"]',
  modelRow: '.model-row-btn[data-action="select-model-row"]',
  settingsLink: '[data-action="open-model-settings"]',
  settingsView: '.settings-view',
  chatBack: '[data-action="chat-back"]',
  settingsBack: '[data-action="settings-back"]',
};

function parseArgs(argv) {
  const out = { write: false, headed: false, out: outDir };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--url') out.url = next();
    else if (a === '--write') out.write = true;
    else if (a === '--headed') out.headed = true;
    else if (a === '--out') out.out = next();
    else if (a === '--help') { console.log('see header'); process.exit(0); }
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

function getJson(base, urlPath, timeoutMs = 20000) {
  const u = new URL(urlPath, base);
  return new Promise((resolve) => {
    const req = http.get(u, { timeout: timeoutMs }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c));
      res.on('end', () => { let body = d; try { body = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, body }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: String(e.code || e.message) }));
  });
}

const results = [];
function record(name, status, detail) {
  const entry = { name, status, detail: detail === undefined ? null : detail };
  results.push(entry);
  console.log(JSON.stringify(entry));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = await resolveTarget();
  const url = args.url || target.verifyUrl;
  const base = new URL(url).origin;
  const token = new URL(url).searchParams.get('token');
  const started = Date.now();
  fs.mkdirSync(args.out, { recursive: true });
  const scratchIdFile = path.join(repoRoot, '.verify', 'E2E_SESSION_ID');
  const scratchId = fs.existsSync(scratchIdFile) ? fs.readFileSync(scratchIdFile, 'utf8').trim() : null;
  console.log(JSON.stringify({ target: url.replace(/token=[^&]+/, 'token=***'), write: args.write, out: args.out, scratchId }));

  // ---- API-level checks ----
  const health = await getJson(base, '/api/health');
  record('health', health.status === 200 && health.body && health.body.ok ? 'PASS' : 'FAIL', health.body || health);
  const boot = await getJson(base, '/api/bootstrap?token=' + encodeURIComponent(token));
  const bootBody = boot.body || {};
  record('bootstrap', boot.status === 200 && bootBody.counts ? 'PASS' : 'FAIL', { status: boot.status, counts: bootBody.counts, models: (bootBody.models && bootBody.models.groups || []).length });
  const sessions = (bootBody.sessions || []).filter((s) => !s.blank);
  record('bootstrap.sessions', sessions.length > 0 ? 'PASS' : 'FAIL', { count: sessions.length });
  const pick = sessions.find((s) => s.id === scratchId) || sessions.find((s) => (s.turns || 0) > 0) || sessions[0] || null;
  if (pick) {
    const det = await getJson(base, '/api/sessions/' + encodeURIComponent(pick.id) + '?token=' + encodeURIComponent(token));
    const msgs = (det.body && det.body.messages) || [];
    record('session.history', det.status === 200 && msgs.length > 0 ? 'PASS' : 'FAIL', { sessionId: pick.id, title: pick.title, messages: msgs.length, oldestSeq: det.body && det.body.oldestSeq });
  }

  // ---- Browser-level checks ----
  let cdp = null;
  try {
    cdp = await Cdp.launch({ headless: !args.headed });
    await cdp.connect();
    const page = await cdp.newPage({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    const shot = async (name) => { const p = path.join(args.out, name); await page.screenshot({ path: p }); return p; };
    await page.navigate(url, { timeout: 30000 });
    await sleep(1500);

    // Tasks view
    const taskCount = await page.evaluate('document.querySelectorAll(' + JSON.stringify(UI.taskCard) + ').length');
    if (taskCount > 0) {
      record('ui.tasks', 'PASS', { cards: taskCount, countLine: await page.evaluate('(document.getElementById("tasks-count")||{}).innerText || ""') });
      await shot('tasks.png');
    } else {
      record('ui.tasks', 'SKIP', { reason: 'no task cards rendered', bodyText: await page.evaluate('document.body ? document.body.innerText.slice(0,300) : ""') });
      await shot('tasks-not-ready.png');
    }

    // Open a session (prefer the scratch E2E session) and assert message DOM
    let opened = false;
    if (taskCount > 0) {
      let clicked = false;
      if (scratchId) {
        const sel = '.task-card[data-action="open-session"][data-id="' + scratchId + '"]';
        clicked = await page.evaluate('!!document.querySelector(' + JSON.stringify(sel) + ')');
        if (clicked) await page.click(sel);
      }
      if (!clicked) { await page.click(UI.taskCard); clicked = true; }
      await sleep(1800);
      const msgCount = await page.evaluate('document.querySelectorAll(' + JSON.stringify(UI.message) + ').length');
      if (msgCount > 0) {
        opened = true;
        record('ui.chat.messages', 'PASS', { messages: msgCount, userMessages: await page.evaluate('document.querySelectorAll(' + JSON.stringify(UI.userMessage) + ').length') });
      } else {
        record('ui.chat.messages', 'SKIP', { reason: 'session opened but no .msg[data-mid] nodes' });
      }
      await shot('chat.png');
      const composer = await page.evaluate('!!document.querySelector(' + JSON.stringify(UI.composer) + ')');
      const sendBtn = await page.evaluate('!!document.querySelector(' + JSON.stringify(UI.sendBtn) + ')');
      record('ui.chat.composer', composer && sendBtn ? 'PASS' : 'SKIP', { composer, sendBtn });
      const changesCard = await page.evaluate('document.querySelectorAll(".changes-card, .change-card, [data-action=\\"toggle-diff\\"]").length');
      record('ui.chat.changesCard', changesCard > 0 ? 'PASS' : 'SKIP', { cards: changesCard, note: 'only file-changing turns render a changes card' });
    }

    // Model sheet + settings view
    const pill = await page.evaluate('!!document.querySelector(' + JSON.stringify(UI.modelPill) + ')');
    if (pill) {
      await page.click(UI.modelPill);
      await sleep(700);
      const rows = await page.evaluate('document.querySelectorAll(' + JSON.stringify(UI.modelRow) + ').length');
      record('ui.modelSheet', rows > 0 ? 'PASS' : 'SKIP', { rows, pillText: await page.evaluate('(document.querySelector(' + JSON.stringify(UI.modelPill) + ')||{}).innerText || ""') });
      await shot('model-sheet.png');
      const link = await page.evaluate('!!document.querySelector(' + JSON.stringify(UI.settingsLink) + ')');
      if (link) {
        await page.click(UI.settingsLink);
        await sleep(1000);
        const settingsOk = await page.evaluate('!!document.querySelector(' + JSON.stringify(UI.settingsView) + ')');
        if (settingsOk) record('ui.settings', 'PASS', { providers: await page.evaluate('document.querySelectorAll(".provider-tab, .provider-item, [data-action=\\"select-provider\\"]").length') });
        else record('ui.settings', 'SKIP', { reason: 'settings view selector .settings-view not found' });
        await shot('settings.png');
      } else {
        record('ui.settings', 'SKIP', { reason: 'no [data-action="open-model-settings"] in model sheet' });
      }
    } else {
      record('ui.modelSheet', 'SKIP', { reason: 'no model pill in chat view' });
      record('ui.settings', 'SKIP', { reason: 'model pill unavailable' });
    }

    // Write path: send -> interrupt -> switch model. Off by default (real turn).
    if (args.write) {
      if (!opened) {
        record('ui.writePath', 'SKIP', { reason: 'chat view not ready; refusing to send' });
      } else {
        try {
          // The settings view may still be open from the checks above: return to the chat view first.
          if (await page.evaluate('!!document.querySelector(".settings-view")')) {
            await page.click(UI.settingsBack);
            await sleep(900);
          }
          if (!(await page.evaluate('!!document.querySelector(' + JSON.stringify(UI.composer) + ')'))) {
            const hasChatBack = await page.evaluate('!!document.querySelector("[data-action=\\"chat-back\\"]")');
            if (hasChatBack) { await page.click(UI.chatBack); await sleep(700); }
            if (scratchId) {
              const sel = '.task-card[data-action="open-session"][data-id="' + scratchId + '"]';
              if (await page.evaluate('!!document.querySelector(' + JSON.stringify(sel) + ')')) { await page.click(sel); await sleep(1200); }
            }
          }
          await page.waitForSelector(UI.composer, { timeout: 10000 });
          const beforeCount = await page.evaluate('document.querySelectorAll(' + JSON.stringify(UI.userMessage) + ').length');
          await page.fill(UI.composer, 'E2E：请只回复 OK，不要调用任何工具。');
          await page.click(UI.sendBtn);
          let runningSeen = false;
          for (let i = 0; i < 40; i++) {
            await sleep(250);
            runningSeen = await page.evaluate('!!document.querySelector("#send-btn.stopping") || (document.querySelector("#send-btn")||{}).getAttribute("data-action") === "stop"');
            if (runningSeen) break;
          }
          const afterCount = await page.evaluate('document.querySelectorAll(' + JSON.stringify(UI.userMessage) + ').length');
          record('ui.write.send', afterCount > beforeCount ? 'PASS' : 'FAIL', { beforeCount, afterCount, runningSeen });
          await shot('chat-sent.png');
          if (runningSeen) {
            await page.click(UI.sendBtn); // stop while running
            let stopped = false;
            for (let i = 0; i < 40; i++) {
              await sleep(250);
              stopped = await page.evaluate('!document.querySelector("#send-btn.stopping")');
              if (stopped) break;
            }
            record('ui.write.interrupt', stopped ? 'PASS' : 'FAIL', { stopped });
            await shot('chat-interrupted.png');
          } else {
            record('ui.write.interrupt', 'SKIP', { reason: 'never observed running state on #send-btn' });
          }
          // switch model via sheet: a model row with reasoning efforts expands an
          // effort chooser first; the selection applies when an effort button is clicked.
          // Some provider/model pairs share a display name, so verify via REST as well.
          const pillNow = await page.evaluate('!!document.querySelector(' + JSON.stringify(UI.modelPill) + ')');
          if (pillNow) {
            const beforePill = await page.evaluate('(document.querySelector(' + JSON.stringify(UI.modelPill) + ')||{}).innerText || ""');
            await page.click(UI.modelPill);
            await sleep(700);
            const rows = await page.evaluate('Array.from(document.querySelectorAll(' + JSON.stringify(UI.modelRow) + ')).map((el) => ({ provider: el.getAttribute("data-provider"), model: el.getAttribute("data-model"), label: ((el.querySelector(".sheet-row-title span") || {}).innerText || (el.innerText || "").split("\\n")[0]).trim(), current: !!(el.closest(".model-row-wrap") && el.closest(".model-row-wrap").classList.contains("is-current")) }))');
            const alt = rows.find((r) => !r.current && r.label && r.label !== beforePill) || rows.find((r) => !r.current) || null;
            if (rows.length > 1 && alt) {
              const altSel = '.model-row-btn[data-provider="' + alt.provider + '"][data-model="' + alt.model + '"]';
              await page.evaluate('(() => { const el = document.querySelector(' + JSON.stringify(altSel) + '); if (el) el.click(); return !!el; })()');
              await sleep(500);
              const effortSel = '.effort-btn[data-action="select-effort"][data-provider="' + alt.provider + '"][data-model="' + alt.model + '"]';
              const efforts = await page.evaluate('Array.from(document.querySelectorAll(' + JSON.stringify(effortSel) + ')).map((el) => el.getAttribute("data-effort"))');
              let chosenEffort = null;
              if (efforts.length) {
                chosenEffort = efforts.find((e) => e === 'max') || efforts[efforts.length - 1];
                const oneSel = effortSel + '[data-effort="' + chosenEffort + '"]';
                await page.evaluate('(() => { const el = document.querySelector(' + JSON.stringify(oneSel) + '); if (el) el.click(); return !!el; })()');
              }
              let afterPill = '';
              let restModel = null;
              for (let k = 0; k < 24; k++) {
                await sleep(250);
                afterPill = await page.evaluate('(document.querySelector(' + JSON.stringify(UI.modelPill) + ')||{}).innerText || ""');
                const det = await getJson(base, '/api/sessions/' + encodeURIComponent(scratchId || '') + '?token=' + encodeURIComponent(token));
                restModel = det.body && det.body.model || null;
                if (restModel && restModel.provider === alt.provider && restModel.model === alt.model) break;
              }
              const restMatches = !!(restModel && restModel.provider === alt.provider && restModel.model === alt.model);
              record('ui.write.switchModel', restMatches || (afterPill && afterPill !== beforePill) ? 'PASS' : 'FAIL', { beforePill, afterPill, target: alt, effortCount: efforts.length, chosenEffort, restModel, note: restMatches && afterPill === beforePill ? 'display names identical; selection confirmed via session REST' : undefined });
              await shot('model-switched.png');
            } else {
              record('ui.write.switchModel', 'SKIP', { reason: 'model sheet rows unavailable', rows: rows.length });
            }
          }
        } catch (err) {
          record('ui.writePath', 'FAIL', { error: String(err && err.message || err) });
        }
      }
    } else {
      record('ui.writePath', 'SKIP', { reason: 'not requested (pass --write to send a real turn)' });
    }

    const pageErrors = (page.errors || []).filter((e) => !/favicon/.test(e.text || ''));
    record('ui.consoleErrors', pageErrors.length === 0 ? 'PASS' : 'WARN', pageErrors.slice(0, 10));
  } catch (err) {
    record('browser', 'FAIL', { error: String(err && err.message || err) });
  } finally {
    try { if (cdp) await cdp.close(); } catch { /* ignore */ }
  }

  const summary = {
    target: url.replace(/token=[^&]+/, 'token=***'),
    startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started,
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    skip: results.filter((r) => r.status === 'SKIP').length,
    warn: results.filter((r) => r.status === 'WARN').length,
    results,
  };
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'e2e-result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ summary: { pass: summary.pass, fail: summary.fail, skip: summary.skip, warn: summary.warn, elapsedMs: summary.elapsedMs } }));
  process.exitCode = summary.fail > 0 ? 1 : 0;
}

main().catch((err) => { console.error('E2E_RUNNER_FAILED', err); process.exitCode = 1; });
