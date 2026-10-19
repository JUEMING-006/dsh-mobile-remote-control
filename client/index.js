/**
 * DeepSeek Harness - 桌面端「手机远控」扫码弹窗（DSH Client 插件模块）
 *
 * 模块格式：window.__ModuleLoader__.load({ id, factory(require) })
 * - React 由 DSH Client 模块表提供，禁止重复安装
 * - 通过 ctx.slots.inject('shell.overlay', ...) 注册悬浮入口与弹窗
 *
 * 数据来源（全部为真实数据，无本地伪造）：
 * - GET  http://127.0.0.1:52880-52889/api/desktop/state   状态 + 二维码 + pairingUrl + 设备数
 * - POST /api/desktop/refresh                              重新探测 IP / 轮换 token / 生成新二维码
 * - POST /api/desktop/stop                                 断开所有手机端连接并停止接受新连接
 * 请求失败时进入错误态并提供「在浏览器中打开配对页」回退，绝不假装成功。
 */
window.__ModuleLoader__.load({
  id: "dsh-mobile-remote-control",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { useState, useEffect, useRef, useCallback } = react;
    const e = react.createElement;

    // ---------------------------------------------------------------------
    // 常量
    // ---------------------------------------------------------------------

    // 后台远控服务只在回环地址的这些端口上监听（首个可用端口起，被占用则顺延）
    const PORT_START = 52880;
    const PORT_END = 52889;
    const CANDIDATE_PORTS = [];
    for (let port = PORT_START; port <= PORT_END; port += 1) CANDIDATE_PORTS.push(port);

    const POLL_INTERVAL_MS = 2000; // SPEC：桌面端状态 2s 轮询
    const PROBE_TIMEOUT_MS = 1200; // 单端口探测超时
    const REQUEST_TIMEOUT_MS = 3000; // 主动操作（refresh/stop）超时
    const REQUEST_TIMEOUT_STATE_MS = 1600; // 状态轮询超时
    const LAST_PAIRING_URL_KEY = "dsh-mobile-remote-control:last-pairing-url";

    // DSH 深色主题色板（与桌面端 UI 一致）
    const C = {
      bg: "#1b1d24",
      border: "#2d3139",
      text: "#e2e8f0",
      textMuted: "#828c9e",
      icon: "#aab4c4",
      danger: "#f85149",
      ready: "#3fb950",
      warn: "#d29922",
      idle: "#828c9e",
    };

    // ---------------------------------------------------------------------
    // 内联 SVG 图标（stroke 1.7，禁止 emoji）
    // ---------------------------------------------------------------------

    function makeIcon(children, size) {
      return e(
        "svg",
        {
          width: size || 16,
          height: size || 16,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          style: { display: "block", flexShrink: 0 },
        },
        children
      );
    }

    // 桌面 + 手机：标题图标
    function IconDesktopPhone(size) {
      return makeIcon(
        [
          e("rect", { key: "mon", x: 2, y: 4, width: 13.5, height: 9.5, rx: 1.8 }),
          e("path", { key: "stand", d: "M6.4 17.2h5.2" }),
          e("path", { key: "neck", d: "M8.9 13.5v3.7" }),
          e("rect", { key: "phone", x: 15, y: 9.5, width: 6.8, height: 11, rx: 1.6 }),
          e("path", { key: "dot", d: "M17.6 17.8h1.7" }),
        ],
        size || 22
      );
    }

    // 手机：内嵌卡标题图标
    function IconPhone(size) {
      return makeIcon(
        [
          e("rect", { key: "body", x: 7, y: 2.3, width: 10, height: 19.4, rx: 2 }),
          e("path", { key: "bar", d: "M10.8 18.2h2.4" }),
        ],
        size || 17
      );
    }

    function IconPower(size) {
      return makeIcon(
        [
          e("path", { key: "arc", d: "M18.36 6.64a9 9 0 1 1-12.73 0" }),
          e("line", { key: "line", x1: 12, y1: 2.4, x2: 12, y2: 11.6 }),
        ],
        size || 15
      );
    }

    function IconRefresh(size) {
      return makeIcon(
        [
          e("path", { key: "a", d: "M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
          e("path", { key: "b", d: "M3 3v5h5" }),
          e("path", { key: "c", d: "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" }),
          e("path", { key: "d", d: "M16 16h5v5" }),
        ],
        size || 15
      );
    }

    function IconCopy(size) {
      return makeIcon(
        [
          e("rect", { key: "front", x: 8.5, y: 8.5, width: 12.5, height: 12.5, rx: 2 }),
          e("path", { key: "back", d: "M4 15.5A2 2 0 0 1 3 14V4.5A1.5 1.5 0 0 1 4.5 3H14a2 2 0 0 1 1 1" }),
        ],
        size || 15
      );
    }

    function IconClose(size) {
      return makeIcon(
        [
          e("line", { key: "a", x1: 18, y1: 6, x2: 6, y2: 18 }),
          e("line", { key: "b", x1: 6, y1: 6, x2: 18, y2: 18 }),
        ],
        size || 15
      );
    }

    function IconAlert(size) {
      return makeIcon(
        [
          e("circle", { key: "c", cx: 12, cy: 12, r: 9 }),
          e("line", { key: "l", x1: 12, y1: 7.6, x2: 12, y2: 13 }),
          e("line", { key: "d", x1: 12, y1: 16.35, x2: 12, y2: 16.5 }),
        ],
        size || 15
      );
    }

    function IconExternal(size) {
      return makeIcon(
        [
          e("path", { key: "box", d: "M13.5 4.5H19.5V10.5" }),
          e("path", { key: "arrow", d: "M19.5 4.5L11 13" }),
          e("path", { key: "frame", d: "M18 14.5v4A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" }),
        ],
        size || 12
      );
    }

    // ---------------------------------------------------------------------
    // 样式（组件内 <style>，随组件卸载移除；类名统一 dsh-rc- 前缀）
    // ---------------------------------------------------------------------

    const STYLES = `
      .dsh-rc-root { display: contents; }
      /* 账号行内叠层：行是 display:block 且账号按钮铺满整行，所以按钮用绝对定位
         叠在行右端。点击命中按钮本身（原生 button，z-index 高于行内元素），不透传。 */
      .dsh-rc-row-host {
        position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
        display: inline-flex; flex: none; align-items: center; z-index: 2;
      }
      .dsh-rc-row-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; padding: 0; margin: 0;
        background: transparent; border: 1px solid transparent; border-radius: 8px;
        color: var(--dsw-alias-label-tertiary, #828c9e);
        cursor: pointer; opacity: 0.75;
        transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease;
      }
      .dsh-rc-row-btn:hover {
        background: rgba(255, 255, 255, 0.045);
        color: var(--dsw-alias-label-primary, #d6dce6);
        opacity: 1;
      }
      .dsh-rc-row-btn:active { opacity: 0.6; transform: scale(0.96); }
      .dsh-rc-row-btn:focus-visible { outline: 2px solid #5b667a; outline-offset: 1px; }
      .dsh-rc-row-btn-icon { display: inline-flex; pointer-events: none; }

      .dsh-rc-backdrop {
        position: fixed; inset: 0; z-index: 2147483000;
        display: flex; align-items: center; justify-content: center;
        padding: 24px; background: rgba(9, 10, 14, 0.66);
        -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
        animation: dsh-rc-fade-in 0.18s ease;
      }
      .dsh-rc-dialog {
        position: relative; box-sizing: border-box; width: 640px; max-width: 100%;
        max-height: calc(100vh - 48px); overflow-y: auto;
        overscroll-behavior: contain;
        background: linear-gradient(180deg, #1e2029 0%, #1b1d24 120px);
        border: 1px solid #2e3340; border-radius: 18px;
        box-shadow: 0 32px 80px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.3);
        padding: 20px 24px; color: #e2e8f0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        font-size: 14px; line-height: 1.55;
        -webkit-tap-highlight-color: transparent;
        animation: dsh-rc-pop 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      @keyframes dsh-rc-fade-in { from { opacity: 0; } }
      @keyframes dsh-rc-pop { from { opacity: 0; transform: scale(0.96) translateY(6px); } }
      .dsh-rc-dialog::-webkit-scrollbar { width: 8px; }
      .dsh-rc-dialog::-webkit-scrollbar-thumb { background: #2d3139; border-radius: 4px; }

      .dsh-rc-head { display: flex; align-items: flex-start; gap: 14px; }
      .dsh-rc-icon-tile {
        display: flex; align-items: center; justify-content: center;
        width: 42px; height: 42px; flex: none;
        border-radius: 12px; background: #23262f; border: 1px solid #2d3139;
        color: #aab4c4;
      }
      .dsh-rc-head-text { flex: 1 1 auto; min-width: 0; padding-top: 1px; }
      .dsh-rc-title { font-size: 16px; font-weight: 650; color: #f1f5fb; letter-spacing: 0.2px; }
      .dsh-rc-subtitle { margin-top: 3px; font-size: 13px; color: #7e8899; line-height: 1.5; }
      .dsh-rc-close {
        display: flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; flex: none; margin: -2px -4px 0 0;
        padding: 0; border: none; border-radius: 8px;
        background: transparent; color: #828c9e; cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .dsh-rc-close:hover { background: #23262f; color: #e2e8f0; }
      .dsh-rc-close:active { opacity: 0.65; }
      .dsh-rc-close:focus-visible { outline: 2px solid #5b667a; outline-offset: 1px; }

      .dsh-rc-card {
        margin-top: 16px; padding: 14px 16px;
        border: 1px solid #2b303c; border-radius: 14px;
        background: rgba(255, 255, 255, 0.015);
      }
      .dsh-rc-card-head {
        display: flex; align-items: center; gap: 8px;
        font-size: 14px; font-weight: 600; color: #e6ebf3;
      }
      .dsh-rc-card-head-icon { display: flex; color: #9aa5b8; }
      .dsh-rc-card-desc { margin: 4px 0 0 24px; font-size: 13px; color: #7e8899; }

      .dsh-rc-status {
        margin-top: 14px; border-radius: 12px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.045);
      }
      .dsh-rc-status-top {
        display: flex; align-items: flex-start; justify-content: space-between;
        gap: 16px; padding: 11px 12px 10px 14px;
      }
      .dsh-rc-status-left { flex: 1 1 auto; min-width: 0; }
      .dsh-rc-status-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .dsh-rc-status-title { font-size: 15px; font-weight: 600; color: #eef2f8; }
      .dsh-rc-pill {
        display: inline-flex; align-items: center; gap: 6px;
        height: 21px; padding: 0 9px; border-radius: 999px;
        background: rgba(255, 255, 255, 0.055); color: #b9c3d2;
        font-size: 12px; font-weight: 500; white-space: nowrap;
      }
      .dsh-rc-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: #828c9e; flex: none; box-shadow: 0 0 0 3px rgba(255,255,255,0.04); }
      .dsh-rc-status-hint { margin-top: 4px; font-size: 12.5px; color: #7e8899; line-height: 1.5; }
      .dsh-rc-stop { flex: none; margin-top: 1px; }

      .dsh-rc-divider { height: 1px; margin: 0 18px; background: #2d3139; }
      .dsh-rc-noscan {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 11px 12px 12px 14px;
      }
      .dsh-rc-noscan-text { flex: 1 1 auto; min-width: 0; font-size: 14px; color: #828c9e; line-height: 1.55; white-space: nowrap; }
      .dsh-rc-actions { display: flex; gap: 10px; flex: none; }

      .dsh-rc-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        height: 34px; padding: 0 12px; border-radius: 9px;
        border: 1px solid rgba(255, 255, 255, 0.09); background: rgba(255, 255, 255, 0.03); color: #cdd6e2;
        font-family: inherit; font-size: 13px; font-weight: 500; line-height: 1;
        white-space: nowrap; cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
      }
      .dsh-rc-btn:hover { background: rgba(255, 255, 255, 0.07); border-color: rgba(255, 255, 255, 0.14); color: #f1f5fb; }
      .dsh-rc-btn:active { opacity: 0.65; }
      .dsh-rc-btn:disabled { opacity: 0.45; cursor: default; background: transparent; border-color: #3a404d; color: #c7d0de; }
      .dsh-rc-btn:focus-visible { outline: 2px solid #5b667a; outline-offset: 1px; }
      .dsh-rc-btn-icon { display: flex; }

      .dsh-rc-banner {
        display: flex; align-items: flex-start; gap: 8px;
        margin-top: 14px; padding: 10px 12px; border-radius: 10px;
        border: 1px solid rgba(248, 81, 73, 0.35);
        background: rgba(248, 81, 73, 0.08); color: #ffb4a8; font-size: 13px;
      }
      .dsh-rc-banner-icon { display: flex; margin-top: 1px; flex: none; }
      .dsh-rc-banner-text { flex: 1 1 auto; min-width: 0; word-break: break-word; }
      .dsh-rc-banner-close {
        display: flex; align-items: center; justify-content: center;
        width: 22px; height: 22px; flex: none; margin: -2px -4px 0 0; padding: 0;
        border: none; border-radius: 6px; background: transparent;
        color: #ffb4a8; cursor: pointer; opacity: 0.8;
      }
      .dsh-rc-banner-close:hover { opacity: 1; background: rgba(248, 81, 73, 0.15); }

      .dsh-rc-qrbox {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 10px; margin-top: 12px; padding: 16px 14px 12px;
        border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 14px;
      }
      .dsh-rc-qr-card {
        padding: 12px; border-radius: 14px; background: #ffffff; line-height: 0;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.06);
      }
      .dsh-rc-qr-img { display: block; width: 272px; height: 272px; }
      .dsh-rc-qr-placeholder {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 12px; width: 272px; height: 272px; padding: 24px;
        color: #5b667a; font-size: 13px; line-height: 1.6; text-align: center;
      }
      .dsh-rc-qr-wrap { position: relative; }
      .dsh-rc-qr-dim {
        position: absolute; inset: 0; border-radius: 12px;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 7px; background: rgba(27, 29, 36, 0.74); color: #e2e8f0; font-size: 14px;
      }
      .dsh-rc-qr-dim-sub { font-size: 12px; color: #828c9e; }
      /* 连接方式切换：一行小胶囊，默认自动选中，点一下即可换入口 */
      .dsh-rc-net {
        display: flex; align-items: center; justify-content: center; gap: 6px;
        margin-top: 10px; padding-top: 10px; width: 100%;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
      }
      .dsh-rc-net-label { font-size: 11.5px; color: #6f7a8c; margin-right: 2px; }
      .dsh-rc-net-chip {
        height: 22px; padding: 0 9px; border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08); background: transparent;
        color: #9aa5b8; font-family: inherit; font-size: 11.5px; cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      }
      .dsh-rc-net-chip:hover { background: rgba(255, 255, 255, 0.05); color: #cdd6e2; }
      .dsh-rc-net-chip-on {
        background: rgba(255, 255, 255, 0.08); color: #eef2f8;
        border-color: rgba(255, 255, 255, 0.16);
      }
      .dsh-rc-net-hint { margin-top: 8px; font-size: 11.5px; color: #d9a94a; line-height: 1.5; text-align: center; }

      .dsh-rc-qr-foot {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 6px; font-size: 12px; color: #6f7a8c;
      }
      .dsh-rc-qr-meta { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 11.5px; color: #7e8899; letter-spacing: 0.2px; }
      .dsh-rc-mock { max-width: 430px; font-size: 12px; line-height: 1.6; color: #d29922; text-align: center; }
      .dsh-rc-link {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 0; border: none; background: none; color: #a9b6c9;
        font-family: inherit; font-size: 12px; cursor: pointer;
        text-decoration: underline; text-underline-offset: 2px;
        text-decoration-color: #3a404d;
      }
      .dsh-rc-link:hover { color: #e2e8f0; text-decoration-color: #5b667a; }
      .dsh-rc-link:active { opacity: 0.65; }
      .dsh-rc-link:focus-visible { outline: 2px solid #5b667a; outline-offset: 2px; border-radius: 3px; }
      .dsh-rc-link-icon { display: flex; }

      .dsh-rc-url {
        width: 100%; max-width: 470px; margin-top: 2px; padding: 8px 10px;
        border: 1px solid #2d3139; border-radius: 8px; background: #171920;
        color: #aab4c4; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 12px;
        line-height: 1.6; word-break: break-all; user-select: all;
      }

      .dsh-rc-qr-error {
        display: flex; flex-direction: column; align-items: center;
        gap: 10px; width: 100%; padding: 30px 20px; text-align: center;
      }
      .dsh-rc-qr-error-icon { display: flex; color: #f85149; }
      .dsh-rc-qr-error-title { font-size: 15px; font-weight: 600; color: #e2e8f0; }
      .dsh-rc-qr-error-msg { max-width: 430px; font-size: 13px; color: #828c9e; line-height: 1.6; word-break: break-word; }
      .dsh-rc-qr-error-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 4px; }
      .dsh-rc-qr-error-hint { max-width: 430px; margin-top: 2px; font-size: 12px; color: #6d7687; line-height: 1.6; }

      .dsh-rc-toast {
        position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%);
        z-index: 2147483001; padding: 8px 14px; border-radius: 9px;
        background: #262a34; border: 1px solid rgba(255, 255, 255, 0.09); color: #eef2f8;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-size: 13px; line-height: 1.4;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45); max-width: 80vw;
        animation: dsh-rc-toast-in 0.2s ease;
      }
      @keyframes dsh-rc-toast-in { from { opacity: 0; transform: translate(-50%, 8px); } }

      @keyframes dsh-rc-rotate { to { transform: rotate(360deg); } }
      @keyframes dsh-rc-fade { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
      .dsh-rc-spin { animation: dsh-rc-rotate 1s linear infinite; }
      .dsh-rc-pulse { animation: dsh-rc-fade 1.6s ease-in-out infinite; }

      @media (max-width: 720px) {
        .dsh-rc-noscan { flex-wrap: wrap; row-gap: 10px; }
        .dsh-rc-noscan-text { flex: 1 1 100%; white-space: normal; }
        .dsh-rc-actions { margin-left: auto; }
      }

      @media (max-width: 640px) {
        .dsh-rc-backdrop { padding: 12px; }
        .dsh-rc-dialog { padding: 20px; border-radius: 14px; max-height: calc(100vh - 24px); }
        .dsh-rc-card { padding: 16px; }
        .dsh-rc-status-top { flex-wrap: wrap; }
        .dsh-rc-stop { margin-left: auto; }
        .dsh-rc-noscan { flex-direction: column; align-items: flex-start; }
        .dsh-rc-noscan-text { max-width: none; }
        .dsh-rc-actions { width: 100%; }
        .dsh-rc-actions .dsh-rc-btn { flex: 1 1 0; }
        .dsh-rc-qrbox { padding: 14px; }
        .dsh-rc-qr-img, .dsh-rc-qr-placeholder { width: 236px; height: 236px; }
        .dsh-rc-qr-card { padding: 14px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .dsh-rc-spin, .dsh-rc-pulse { animation: none !important; }
        .dsh-rc-backdrop, .dsh-rc-dialog, .dsh-rc-toast { animation: none !important; }
      }
    `;

    // ---------------------------------------------------------------------
    // 网络：端口探测 / 请求封装 / 状态归一化
    // ---------------------------------------------------------------------

    function fetchJson(url, options) {
      const opts = options || {};
      const timeoutMs = opts.timeout || REQUEST_TIMEOUT_STATE_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetch(url, {
        method: opts.method || "GET",
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        headers: Object.assign({ Accept: "application/json" }, opts.headers || {}),
        ...(opts.body === undefined ? {} : { body: opts.body }),
      })
        .then((res) => {
          return res
            .text()
            .then((text) => ({ res: res, text: text }))
            .catch(() => ({ res: res, text: "" }));
        })
        .then((result) => {
          let body = null;
          if (result.text) {
            try {
              body = JSON.parse(result.text);
            } catch (parseError) {
              body = null;
            }
          }
          if (!result.res.ok) {
            const reason =
              body && typeof body === "object" ? body.error || body.message || "" : "";
            const err = new Error(
              reason ? "HTTP " + result.res.status + "：" + reason : "HTTP " + result.res.status
            );
            err.status = result.res.status;
            err.body = body;
            throw err;
          }
          if (body === null) {
            const err = new Error("接口返回的不是有效 JSON");
            err.invalidBody = true;
            throw err;
          }
          return body;
        })
        .finally(() => clearTimeout(timer));
    }

    /**
     * 探测回环端口上的远控服务：GET /api/health 返回 200 且 body.mode 存在（host/mock）才算命中，
     * 命中后再读取 GET /api/desktop/state（SPEC 3.2）。preferredPort 优先复用上次成功端口。
     */
    function requestDesktopState(preferredPort) {
      const ports = CANDIDATE_PORTS.slice();
      if (preferredPort && ports.indexOf(preferredPort) !== -1) {
        ports.splice(ports.indexOf(preferredPort), 1);
        ports.unshift(preferredPort);
      }

      let lastError = null;
      let sawForeignService = false;
      let sawPluginService = false;
      let pluginServiceDiagnostic = "";

      function fetchState(port) {
        return fetchJson("http://127.0.0.1:" + port + "/api/desktop/state", {
          timeout: PROBE_TIMEOUT_MS,
        }).then((data) => ({ port: port, data: data }));
      }

      function tryPort(index) {
        if (index >= ports.length) {
          const finalError = new Error(
            sawPluginService && pluginServiceDiagnostic
              ? pluginServiceDiagnostic + "请确认部署的是最新版本并重启 DeepSeek Harness。"
              : sawForeignService
              ? "本机端口上存在其它 HTTP 服务，但未找到符合约定的桌面端远控服务（/api/health 缺少 mode 字段）。请确认插件版本与部署是否最新。"
              : "未找到运行中的桌面端远控服务（已尝试 127.0.0.1:" +
                  PORT_START +
                  "–" +
                  PORT_END +
                  "）。可能尚未启动、被浏览器安全策略拦截或端口被占用。"
          );
          finalError.probe = true;
          finalError.cause = lastError;
          throw finalError;
        }

        const port = ports[index];
        return fetchJson("http://127.0.0.1:" + port + "/api/health", {
          timeout: PROBE_TIMEOUT_MS,
        })
          .then((health) => {
            const mode =
              health && typeof health === "object" && typeof health.mode === "string"
                ? health.mode
                : "";
            if (mode !== "host" && mode !== "mock") {
              sawForeignService = true;
              return tryPort(index + 1);
            }
            return fetchState(port).catch((stateError) => {
              // 命中本插件服务但接口失败（可能是该实例卡住/超时）。
              // 记下诊断信息并继续尝试其它端口 —— 同机上可能存在多个实例，
              // 健康的那个不应该被卡住的端口连累。
              sawPluginService = true;
              pluginServiceDiagnostic =
                "已找到桌面端服务（端口 " + port + "，mode=" + mode +
                "），但桌面接口不可用（" +
                (stateError && stateError.message ? stateError.message : "未知错误") +
                "）。";
              lastError = stateError;
              return tryPort(index + 1);
            });
          })
          .catch((err) => {
            if (err && err.probe) throw err;
            lastError = err;
            return tryPort(index + 1);
          });
      }

      return tryPort(0);
    }

    function normalizeState(raw, port) {
      const source = raw && typeof raw === "object" ? raw : {};
      const rawState = source.state;
      let state;
      if (rawState === "stopped") state = "stopped";
      else if (rawState === "ready") state = "ready";
      else if (source.ready === true) state = "ready";
      else if (source.ready === false) state = "stopped";
      else state = "ready";

      const qrDataUrl =
        typeof source.qrDataUrl === "string" && /^data:image\//i.test(source.qrDataUrl)
          ? source.qrDataUrl
          : "";
      const pairingUrl =
        typeof source.pairingUrl === "string" && /^https?:\/\//i.test(source.pairingUrl)
          ? source.pairingUrl
          : "";
      const altUrls = Array.isArray(source.altUrls)
        ? source.altUrls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u) && u !== source.pairingUrl)
        : [];
      const candidates = Array.isArray(source.candidates)
        ? source.candidates.filter((ip) => typeof ip === "string")
        : [];
      const deviceCount = Number.isFinite(source.deviceCount)
        ? Math.max(0, Math.trunc(source.deviceCount))
        : 0;
      const lanIp = typeof source.lanIp === "string" ? source.lanIp : "";
      const portNumber = Number.isFinite(source.port) ? source.port : port;
      const version = typeof source.version === "string" ? source.version : "";
      const mode =
        source.mode === "host" || source.mode === "mock" ? source.mode : "";
      const protocol = Number.isFinite(source.protocol) ? source.protocol : null;

      return {
        state: state,
        qrDataUrl: qrDataUrl,
        pairingUrl: pairingUrl,
        altUrls: altUrls,
        candidates: candidates,
        deviceCount: deviceCount,
        lanIp: lanIp,
        port: portNumber,
        version: version,
        mode: mode,
        protocol: protocol,
      };
    }

    function describeError(err) {
      if (!err) return "未知错误";
      if (err.name === "AbortError") {
        return "请求超时：桌面端后台未在预期时间内响应。";
      }
      if (err.probe) return err.message;
      if (err.invalidBody) {
        return "桌面端接口返回了无法识别的内容，请确认已部署最新版本。";
      }
      if (typeof err.status === "number") {
        return "桌面端接口返回错误（" + (err.message || "HTTP " + err.status) + "）。";
      }
      const raw = err && err.message ? String(err.message) : String(err);
      if (/failed to fetch|networkerror|load failed|fetch/i.test(raw)) {
        return "无法连接本机桌面端服务：请求被拒绝，可能未启动、端口被占用，或被浏览器安全策略（CSP/跨域）拦截。";
      }
      return raw || "无法连接本机桌面端服务。";
    }

    // ---------------------------------------------------------------------
    // 工具：剪贴板 / 在新窗口打开
    // ---------------------------------------------------------------------

    function legacyCopyText(text) {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.top = "0";
        textarea.style.left = "0";
        textarea.style.width = "1px";
        textarea.style.height = "1px";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        if (typeof textarea.setSelectionRange === "function") {
          textarea.setSelectionRange(0, text.length);
        }
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        return ok;
      } catch (err) {
        return false;
      }
    }

    function copyText(text) {
      if (!text) return Promise.resolve(false);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard
          .writeText(text)
          .then(() => true)
          .catch(() => legacyCopyText(text));
      }
      return Promise.resolve(legacyCopyText(text));
    }

    function openInBrowser(url) {
      if (!url) return false;
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        return true;
      } catch (err) {
        try {
          window.open(url, "_blank", "noopener,noreferrer");
          return true;
        } catch (openError) {
          return false;
        }
      }
    }

    function readCachedPairingUrl() {
      try {
        const value = window.localStorage.getItem(LAST_PAIRING_URL_KEY);
        return typeof value === "string" && /^https?:\/\//i.test(value) ? value : "";
      } catch (err) {
        return "";
      }
    }

    function writeCachedPairingUrl(url) {
      try {
        window.localStorage.setItem(LAST_PAIRING_URL_KEY, url);
      } catch (err) {
        // localStorage 不可用时忽略（不影响主流程）
      }
    }

    // ---------------------------------------------------------------------
    // 弹窗组件
    // ---------------------------------------------------------------------

    function RemoteControlModal(props) {
      const visible = props.visible;
      const onClose = props.onClose;

      const [phase, setPhase] = useState("loading"); // 'loading' | 'ok' | 'error'
      const [snapshot, setSnapshot] = useState(null);
      const [errorText, setErrorText] = useState("");
      const [actionError, setActionError] = useState("");
      const [busy, setBusy] = useState(""); // '' | 'refresh' | 'stop'
      const [copyState, setCopyState] = useState(""); // '' | 'ok'
      const [showUrl, setShowUrl] = useState(false);
      const [toast, setToast] = useState("");

      const mountedRef = useRef(true);
      const inFlightRef = useRef(false);
      const failStreakRef = useRef(0);
      const basePortRef = useRef(null);
      const lastSnapshotRef = useRef(null);
      const cachedUrlRef = useRef(readCachedPairingUrl());
      const lastCandidatesRef = useRef([]);
      const [netHint, setNetHint] = useState("");
      const toastTimerRef = useRef(null);
      const copyTimerRef = useRef(null);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        };
      }, []);

      const showToast = useCallback((message) => {
        setToast(message);
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setToast("");
        }, 1800);
      }, []);

      const commitSnapshot = useCallback((next) => {
        // Tailscale 掉线检测：上一轮还有 100.x 候选、这一轮没有了 → 明确告知用户，
        // 否则面板"悄悄"切回局域网地址，手机会一直连不上且看不出原因。
        const prev = lastCandidatesRef.current || [];
        const now = Array.isArray(next.candidates) ? next.candidates : [];
        const isTailscale = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
        const hadTs = prev.some(isTailscale);
        const hasTs = now.some(isTailscale);
        if (hadTs && !hasTs) setNetHint("Tailscale 已断开，当前显示局域网入口；重新连接后会自动切回。");
        else if (!hadTs && hasTs) setNetHint("");
        lastCandidatesRef.current = now;
        lastSnapshotRef.current = next;
        setSnapshot(next);
        if (next.pairingUrl) {
          cachedUrlRef.current = next.pairingUrl;
          writeCachedPairingUrl(next.pairingUrl);
        }
      }, []);

      // 拉取真实状态；返回是否成功（轮询失败连续 2 次才进入错误态，避免瞬时抖动）
      const loadState = useCallback(
        (kind) => {
          if (inFlightRef.current) return Promise.resolve(false);
          inFlightRef.current = true;
          if (kind === "initial" && !lastSnapshotRef.current) setPhase("loading");
          return requestDesktopState(basePortRef.current)
            .then((result) => {
              if (!mountedRef.current) return false;
              basePortRef.current = result.port;
              failStreakRef.current = 0;
              commitSnapshot(normalizeState(result.data, result.port));
              setPhase("ok");
              setErrorText("");
              return true;
            })
            .catch((err) => {
              if (!mountedRef.current) return false;
              failStreakRef.current += 1;
              const reachedThreshold =
                kind !== "poll" || failStreakRef.current >= 2 || !lastSnapshotRef.current;
              if (reachedThreshold) {
                setPhase("error");
                setErrorText(describeError(err));
              }
              return false;
            })
            .finally(() => {
              inFlightRef.current = false;
            });
        },
        [commitSnapshot]
      );

      // 打开时拉取状态并 2s 轮询；关闭时停止轮询
      useEffect(() => {
        if (!visible) return undefined;
        failStreakRef.current = 0;
        loadState(lastSnapshotRef.current ? "poll" : "initial");
        const timer = setInterval(() => loadState("poll"), POLL_INTERVAL_MS);
        return () => clearInterval(timer);
      }, [visible, loadState]);

      // Esc 关闭 + 锁定页面滚动
      useEffect(() => {
        if (!visible) return undefined;
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        };
        document.addEventListener("keydown", onKeyDown, true);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
          document.removeEventListener("keydown", onKeyDown, true);
          document.body.style.overflow = previousOverflow;
        };
      }, [visible, onClose]);

      const applyStateResponse = useCallback(
        (data) => {
          if (
            data &&
            typeof data === "object" &&
            (Object.prototype.hasOwnProperty.call(data, "state") ||
              Object.prototype.hasOwnProperty.call(data, "ready"))
          ) {
            commitSnapshot(normalizeState(data, basePortRef.current));
            setPhase("ok");
            setErrorText("");
            return Promise.resolve(true);
          }
          // 响应体不是状态对象：重新拉取真实状态，绝不猜测
          return loadState("manual").then(() => false);
        },
        [commitSnapshot, loadState]
      );

      const postDesktop = useCallback((path, body) => {
        const port = basePortRef.current || CANDIDATE_PORTS[0];
        return fetchJson("http://127.0.0.1:" + port + path, {
          method: "POST",
          timeout: REQUEST_TIMEOUT_MS,
          ...(body === undefined
            ? {}
            : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        });
      }, []);

      const handleRefresh = useCallback(() => {
        if (busy) return;
        setActionError("");
        setBusy("refresh");

        const doRefresh = () =>
          postDesktop("/api/desktop/refresh").then((data) => applyStateResponse(data));
        // 尚未连接到后台时先重新探测端口，连上后再真正 POST refresh（不伪造成功）
        const task = basePortRef.current
          ? doRefresh()
          : loadState("manual").then((connected) => (connected ? doRefresh() : false));

        return task
          .then((applied) => {
            if (!applied) {
              showToast("状态已重新同步，但未能确认二维码已刷新");
              return;
            }
            if (lastSnapshotRef.current && lastSnapshotRef.current.state === "stopped") {
              showToast("后台仍处于已停止状态，请重启 DeepSeek Harness 后重试");
            } else {
              showToast("二维码已刷新");
            }
          })
          .catch((err) => {
            setActionError("刷新二维码失败：" + describeError(err));
          })
          .finally(() => {
            if (mountedRef.current) setBusy("");
          });
      }, [busy, loadState, postDesktop, applyStateResponse, showToast]);

      const handleStop = useCallback(() => {
        if (busy || !basePortRef.current) return;
        setActionError("");
        setBusy("stop");
        return postDesktop("/api/desktop/stop")
          .then((data) => applyStateResponse(data))
          .then((applied) => {
            if (!applied) {
              showToast("已发送停止请求，状态已重新同步");
            } else if (
              lastSnapshotRef.current &&
              lastSnapshotRef.current.state === "stopped"
            ) {
              showToast("已停止远程连接");
            } else {
              setActionError(
                "停止请求已返回，但后台状态未变为「已停止」，请重试或重启 DeepSeek Harness。"
              );
            }
          })
          .catch((err) => {
            setActionError("停止远程连接失败：" + describeError(err));
          })
          .finally(() => {
            if (mountedRef.current) setBusy("");
          });
      }, [busy, postDesktop, applyStateResponse, showToast]);

      const handleCopy = useCallback(() => {
        const url =
          (lastSnapshotRef.current && lastSnapshotRef.current.pairingUrl) ||
          cachedUrlRef.current;
        if (!url) {
          setShowUrl(true);
          showToast("尚未获取到配对链接，请先重试连接");
          return Promise.resolve();
        }
        return copyText(url).then((ok) => {
          if (!mountedRef.current) return;
          if (ok) {
            setCopyState("ok");
            showToast("配对链接已复制");
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
            copyTimerRef.current = setTimeout(() => {
              if (mountedRef.current) setCopyState("");
            }, 2000);
          } else {
            setShowUrl(true);
            showToast("自动复制失败，请手动复制下方链接");
          }
        });
      }, [showToast]);

      const handleOpenPairing = useCallback(() => {
        const url =
          (lastSnapshotRef.current && lastSnapshotRef.current.pairingUrl) ||
          cachedUrlRef.current;
        if (!url) {
          setActionError("尚未获取到配对页地址，无法在浏览器中打开。请先重试连接。");
          return;
        }
        const ok = openInBrowser(url);
        if (!ok) setActionError("打开浏览器失败，请手动复制配对链接。");
      }, []);

      // 网卡标签：Tailscale(100.64/10) → Tailscale；其余按网段给可读名
      const netChipLabel = (ip) => {
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return "Tailscale";
        if (/^192\.168\.137\./.test(ip)) return "热点";
        if (/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return "局域网";
        return ip;
      };

      // 手动切到指定网卡：只改配对地址与二维码，token 不变，已连手机不受影响
      const handleUseIp = useCallback(
        (ip) => {
          if (busy) return;
          setActionError("");
          setBusy("net");
          postDesktop("/api/desktop/use-ip", { ip: ip })
            .then((data) => {
              const applied = applyStateResponse(data);
              if (applied) showToast("已切换到 " + netChipLabel(ip));
            })
            .catch((err) => setActionError("切换连接方式失败：" + describeError(err)))
            .finally(() => {
              if (mountedRef.current) setBusy("");
            });
        },
        [busy, postDesktop, applyStateResponse, showToast]
      );

      const handleRetry = useCallback(() => {
        setActionError("");
        loadState("manual");
      }, [loadState]);

      if (!visible) return null;

      // ---- 状态派生（全部来自真实状态） ----
      const snap = snapshot;
      let statusKind = "loading";
      if (phase === "error") statusKind = "error";
      else if (snap) {
        if (snap.state === "stopped") statusKind = "stopped";
        else if (snap.deviceCount > 0) statusKind = "connected";
        else statusKind = "ready";
      }

      const altUrls = (snap && Array.isArray(snap.altUrls) ? snap.altUrls : []).slice(0, 4);
      const candidates = snap && Array.isArray(snap.candidates) ? snap.candidates : [];

      const statusLabel =
        statusKind === "error"
          ? "连接失败"
          : statusKind === "loading"
            ? "加载中"
            : statusKind === "stopped"
              ? "已停止"
              : statusKind === "connected"
                ? "已连接 " + snap.deviceCount + " 台"
                : "已就绪";

      const statusDotColor =
        statusKind === "error"
          ? C.danger
          : statusKind === "loading"
            ? C.warn
            : statusKind === "stopped"
              ? C.idle
              : C.ready;

      const statusTitle =
        statusKind === "error"
          ? "无法连接桌面端服务"
          : statusKind === "loading"
            ? "正在连接桌面端服务…"
            : statusKind === "stopped"
              ? "远程控制已停止"
              : statusKind === "connected"
                ? "已连接 " + snap.deviceCount + " 台设备"
                : "等待手机连接";

      const statusHint =
        statusKind === "error"
          ? "请确认插件已在 DeepSeek Harness 中启用，并按 README 重新部署后重启桌面端。"
          : statusKind === "loading"
            ? "正在探测本机远控服务端口（" + PORT_START + "–" + PORT_END + "）。"
            : statusKind === "stopped"
              ? "已断开所有手机连接并停止接受新连接；点击「刷新二维码」可尝试重新开启。"
              : statusKind === "connected"
                ? "手机端操作会实时同步到当前工作区。"
                : "用手机扫码，或在手机上打开链接。";

      const stopDisabled =
        Boolean(busy) ||
        phase === "error" ||
        !snap ||
        statusKind === "loading" ||
        statusKind === "stopped";

      const stopTitle =
        statusKind === "stopped"
          ? "远程控制已停止"
          : phase === "error" || !snap
            ? "尚未连接桌面端服务，无法停止"
            : "断开所有手机端连接并停止接受新连接";

      const stopLabel = busy === "stop" ? "停止中…" : "停止";
      const refreshLabel = busy === "refresh" ? "刷新中…" : "刷新二维码";
      const copyLabel = copyState === "ok" ? "已复制" : "复制链接";

      const hasQr = Boolean(snap && snap.qrDataUrl);
      const metaText = snap
        ? snap.lanIp
          ? snap.lanIp + ":" + snap.port
          : snap.port
            ? "127.0.0.1:" + snap.port
            : ""
        : "";
      // mock 徽标里才出现版本号；正常状态不污染地址行
      const mockText =
        snap && snap.mode === "mock"
          ? "mock 模式：数据仅用于 UI 联调，不代表真实会话。" +
            (snap.version ? "（v" + snap.version + "）" : "")
          : "";

      let qrCard;
      if (hasQr) {
        qrCard = e("img", {
          className: "dsh-rc-qr-img",
          src: snap.qrDataUrl,
          alt: "手机扫码连接二维码",
          width: 300,
          height: 300,
          draggable: false,
        });
      } else {
        const spinning = statusKind === "loading";
        qrCard = e(
          "div",
          { className: "dsh-rc-qr-placeholder" },
          e(
            "span",
            {
              className: spinning ? "dsh-rc-spin" : "",
              style: { display: "flex", color: "#828c9e" },
              "aria-hidden": "true",
            },
            statusKind === "stopped" ? IconPower(20) : IconRefresh(20)
          ),
          e(
            "span",
            null,
            spinning
              ? "正在获取二维码…"
              : statusKind === "stopped"
                ? "远程控制已停止"
                : "后台未返回二维码，请点击「刷新二维码」"
          )
        );
      }

      let qrContent;
      if (phase === "error") {
        qrContent = e(
          "div",
          { className: "dsh-rc-qr-error", role: "alert" },
          e("span", { className: "dsh-rc-qr-error-icon", "aria-hidden": "true" }, IconAlert(22)),
          e("div", { className: "dsh-rc-qr-error-title" }, "无法获取二维码"),
          e("div", { className: "dsh-rc-qr-error-msg" }, errorText || "无法连接本机桌面端服务。"),
          e(
            "div",
            { className: "dsh-rc-qr-error-actions" },
            e(
              "button",
              { type: "button", className: "dsh-rc-btn", onClick: handleRetry },
              e("span", { className: "dsh-rc-btn-icon", "aria-hidden": "true" }, IconRefresh(14)),
              e("span", null, "重试")
            ),
            e(
              "button",
              {
                type: "button",
                className: "dsh-rc-btn",
                onClick: handleOpenPairing,
                title: cachedUrlRef.current
                  ? "打开上次获取的配对页"
                  : "尚未获取到配对链接",
              },
              e("span", { className: "dsh-rc-btn-icon", "aria-hidden": "true" }, IconExternal(14)),
              e("span", null, "在浏览器中打开配对页")
            )
          ),
          e(
            "div",
            { className: "dsh-rc-qr-error-hint" },
            "若持续失败：确认插件已在桌面端启用（npm run deploy 后需重启 DeepSeek Harness），并确认 " +
              PORT_START +
              "–" +
              PORT_END +
              " 端口未被其它程序占用。"
          )
        );
      } else if (statusKind === "stopped") {
        qrContent = e(
          react.Fragment,
          null,
          e(
            "div",
            { className: "dsh-rc-qr-wrap" },
            e("div", { className: "dsh-rc-qr-card" }, qrCard),
            e(
              "div",
              { className: "dsh-rc-qr-dim", "aria-hidden": "true" },
              e("span", { style: { display: "flex", color: "#828c9e" } }, IconPower(22)),
              e("span", null, "远程控制已停止"),
              e("span", { className: "dsh-rc-qr-dim-sub" }, "手机端将无法连接")
            )
          ),
          e(
            "div",
            { className: "dsh-rc-qr-foot" },
            metaText ? e("span", { className: "dsh-rc-qr-meta" }, metaText) : null,
            e(
              "button",
              { type: "button", className: "dsh-rc-link", onClick: handleOpenPairing },
              e("span", null, "在浏览器中打开配对页"),
              e("span", { className: "dsh-rc-link-icon", "aria-hidden": "true" }, IconExternal(11))
            )
          )
        );
      } else if (statusKind === "loading") {
        qrContent = e("div", { className: "dsh-rc-qr-card" }, qrCard);
      } else {
        qrContent = e(
          react.Fragment,
          null,
          e("div", { className: "dsh-rc-qr-card" }, qrCard),
          e(
            "div",
            { className: "dsh-rc-qr-foot" },
            metaText ? e("span", { className: "dsh-rc-qr-meta" }, metaText) : null,
            e(
              "button",
              { type: "button", className: "dsh-rc-link", onClick: handleOpenPairing },
              e("span", null, "在浏览器中打开配对页"),
              e("span", { className: "dsh-rc-link-icon", "aria-hidden": "true" }, IconExternal(11))
            ),
            candidates.length > 1
              ? e(
                  "div",
                  { className: "dsh-rc-net" },
                  e("span", { className: "dsh-rc-net-label" }, "连接方式"),
                  candidates.map((ip) =>
                    e(
                      "button",
                      {
                        key: ip,
                        type: "button",
                        className:
                          "dsh-rc-net-chip" + (snap && snap.lanIp === ip ? " dsh-rc-net-chip-on" : ""),
                        title: ip + ":" + (snap ? snap.port : ""),
                        onClick: () => handleUseIp(ip),
                      },
                      netChipLabel(ip)
                    )
                  )
                )
              : null,
            netHint
              ? e("div", { className: "dsh-rc-net-hint" }, netHint)
              : null
          )
        );
      }

      return e(
        "div",
        { className: "dsh-rc-root" },
        e(
          "div",
          {
            className: "dsh-rc-backdrop",
            onClick: (event) => {
              if (event.target === event.currentTarget) onClose();
            },
          },
          e(
            "div",
            {
              className: "dsh-rc-dialog",
              role: "dialog",
              "aria-modal": "true",
              "aria-labelledby": "dsh-rc-title",
              onClick: (event) => event.stopPropagation(),
            },
            e(
              "div",
              { className: "dsh-rc-head" },
              e("div", { className: "dsh-rc-icon-tile", "aria-hidden": "true" }, IconDesktopPhone(23)),
              e(
                "div",
                { className: "dsh-rc-head-text" },
                e("div", { className: "dsh-rc-title", id: "dsh-rc-title" }, "移动端远程控制"),
                e(
                  "div",
                  { className: "dsh-rc-subtitle" },
                  "扫码或在手机上打开链接，即可远程控制当前工作区。"
                )
              ),
              e(
                "button",
                {
                  type: "button",
                  className: "dsh-rc-close",
                  onClick: onClose,
                  "aria-label": "关闭",
                  title: "关闭",
                },
                IconClose()
              )
            ),
            e(
              "div",
              { className: "dsh-rc-card" },
              e(
                "div",
                { className: "dsh-rc-card-head" },
                e("span", { className: "dsh-rc-card-head-icon", "aria-hidden": "true" }, IconPhone(16)),
                e("span", null, "手机扫码连接")
              ),
              e("div", { className: "dsh-rc-card-desc" }, "用手机相机扫码，在手机上打开这个工作区。"),
              e(
                "div",
                { className: "dsh-rc-status" },
                e(
                  "div",
                  { className: "dsh-rc-status-top" },
                  e(
                    "div",
                    { className: "dsh-rc-status-left" },
                    e(
                      "div",
                      { className: "dsh-rc-status-line" },
                      e("span", { className: "dsh-rc-status-title" }, statusTitle),
                      e(
                        "span",
                        {
                          className: "dsh-rc-pill",
                          role: "status",
                          "aria-live": "polite",
                        },
                        e("span", {
                          className:
                            "dsh-rc-pill-dot" +
                            (statusKind === "connected" || statusKind === "loading"
                              ? " dsh-rc-pulse"
                              : ""),
                          style: { background: statusDotColor },
                        }),
                        e("span", null, statusLabel)
                      )
                    ),
                    e("div", { className: "dsh-rc-status-hint" }, statusHint)
                  ),
                  e(
                    "button",
                    {
                      type: "button",
                      className: "dsh-rc-btn dsh-rc-stop",
                      onClick: handleStop,
                      disabled: stopDisabled,
                      title: stopTitle,
                    },
                    e(
                      "span",
                      {
                        className:
                          "dsh-rc-btn-icon" + (busy === "stop" ? " dsh-rc-spin" : ""),
                        "aria-hidden": "true",
                      },
                      IconPower(15)
                    ),
                    e("span", null, stopLabel)
                  )
                ),
                e("div", { className: "dsh-rc-divider" }),
                e(
                  "div",
                  { className: "dsh-rc-noscan" },
                  e("div", { className: "dsh-rc-noscan-text" }, "无法扫码？可在手机上打开链接。"),
                  e(
                    "div",
                    { className: "dsh-rc-actions" },
                    e(
                      "button",
                      {
                        type: "button",
                        className: "dsh-rc-btn",
                        onClick: handleRefresh,
                        disabled: Boolean(busy),
                      },
                      e(
                        "span",
                        {
                          className:
                            "dsh-rc-btn-icon" +
                            (busy === "refresh" ? " dsh-rc-spin" : ""),
                          "aria-hidden": "true",
                        },
                        IconRefresh(14)
                      ),
                      e("span", null, refreshLabel)
                    ),
                    e(
                      "button",
                      { type: "button", className: "dsh-rc-btn", onClick: handleCopy },
                      e("span", { className: "dsh-rc-btn-icon", "aria-hidden": "true" }, IconCopy(14)),
                      e("span", null, copyLabel)
                    )
                  )
                )
              ),
              actionError
              ? e(
                  "div",
                  { className: "dsh-rc-banner", role: "alert" },
                  e("span", { className: "dsh-rc-banner-icon", "aria-hidden": "true" }, IconAlert(14)),
                  e("span", { className: "dsh-rc-banner-text" }, actionError),
                  e(
                    "button",
                    {
                      type: "button",
                      className: "dsh-rc-banner-close",
                      onClick: () => setActionError(""),
                      "aria-label": "忽略这条提示",
                      title: "忽略",
                    },
                    IconClose(12)
                  )
                )
              : null,
              e(
                "div",
                { className: "dsh-rc-qrbox" },
                qrContent,
                showUrl
                  ? e(
                      "div",
                      { className: "dsh-rc-url", title: "手动选择并复制配对链接" },
                      (snap && snap.pairingUrl) ||
                        cachedUrlRef.current ||
                        "（尚未获取到配对链接）"
                    )
                  : null,
                mockText
                  ? e("div", { className: "dsh-rc-mock" }, mockText)
                  : null
              )
            )
          )
        ),
        toast
          ? e("div", { className: "dsh-rc-toast", role: "status", "aria-live": "polite" }, toast)
          : null
      );
    }

    // ---------------------------------------------------------------------
    // 悬浮入口
    // ---------------------------------------------------------------------

// ---------------------------------------------------------------------
    // 侧边栏底部入口（sidebar.footer.action 槽位：账号行上方的图标排）
    // ---------------------------------------------------------------------
    function RemoteControlFooterEntry() {
      const [modalVisible, setModalVisible] = useState(false);
      return e(
        react.Fragment,
        null,
        e(
          "button",
          {
            type: "button",
            className: "dsh-rc-footer-entry",
            onClick: () => setModalVisible(true),
            title: "手机远控：扫码连接",
            "aria-label": "打开手机远控连接面板",
            "aria-haspopup": "dialog",
            "aria-expanded": modalVisible,
          },
          e("span", { className: "dsh-rc-footer-entry-icon", "aria-hidden": "true" }, IconDesktopPhone(16))
        ),
        e(RemoteControlModal, {
          visible: modalVisible,
          onClose: () => setModalVisible(false),
        })
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      if (!ctx || !ctx.slots) return;
      // 主入口：账号行内的「手机远控」按钮（渲染在设置触发器旁边）。
      // 挂载方式：MutationObserver 找到账号行后把按钮插进去；点击只命中按钮自身
      // （stopPropagation），不会透传到底下的设置入口。
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "dsh-mobile-remote-control-entry",
            inject: () => ({}),
          },
          RemoteControlRowEntry
        )
      );
    }

    // 定位账号行：左下角的账号菜单按钮（aria-label「账号菜单」/「Account」，
    // aria-haspopup="menu"），其外层 div 即账号行。找不到时回退：视口底部 80px 内
    // 左侧 300px 里带 aria-haspopup="menu" 的按钮。
    function findAccountRow() {
      let btn = document.querySelector('button[aria-label="账号菜单"], button[aria-label="Account menu"], button[aria-label="Account"]');
      if (!btn) {
        for (const cand of document.querySelectorAll('button[aria-haspopup="menu"]')) {
          const rect = cand.getBoundingClientRect();
          if (rect.y > window.innerHeight - 90 && rect.x < 300) { btn = cand; break; }
        }
      }
      if (!btn) return null;
      // 从按钮向外找高度 32–64px 的行容器（ET65mq_root 之类）
      let row = btn.closest("div");
      for (let i = 0; i < 4 && row; i += 1) {
        const h = row.getBoundingClientRect().height;
        if (h >= 32 && h <= 64) return row;
        row = row.parentElement;
      }
      return btn.closest("div");
    }

    function RemoteControlRowEntry() {
      const [modalVisible, setModalVisible] = useState(false);
      const hostRef = useRef(null);

      useEffect(() => {
        let cancelled = false;
        let attempts = 0;
        const tryMount = () => {
          if (cancelled || hostRef.current) return;
          attempts += 1;
          const row = findAccountRow();
          if (row && row.parentElement) {
            const host = document.createElement("span");
            host.className = "dsh-rc-row-host";
            row.appendChild(host); // 行内右端（绝对定位，见 .dsh-rc-row-host 样式）
            if (getComputedStyle(row).position === "static") row.style.position = "relative";
            hostRef.current = host;
            // 纯 DOM 渲染按钮（不依赖 react-dom，模块表未必提供）
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "dsh-rc-row-btn";

            btn.setAttribute("aria-label", "打开手机远控连接面板");
            btn.setAttribute("aria-haspopup", "dialog");
            btn.addEventListener("click", (event) => {
              event.stopPropagation();
              event.preventDefault();
              setModalVisible(true);
            });
            const icon = document.createElement("span");
            icon.className = "dsh-rc-row-btn-icon";
            icon.setAttribute("aria-hidden", "true");
            // 与 IconDesktopPhone 同形的内联 SVG（stroke 继承按钮 color）
            icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="display:block" aria-hidden="true">'
              + '<rect x="2" y="4" width="13.5" height="9.5" rx="1.8"/>'
              + '<path d="M6.4 17.2h5.2"/><path d="M8.9 13.5v3.7"/>'
              + '<rect x="15" y="9.5" width="6.8" height="11" rx="1.6"/>'
              + '<path d="M17.6 17.8h1.7"/>'
              + '</svg>';
            btn.appendChild(icon);
            host.appendChild(btn);
          } else if (attempts < 100) {
            setTimeout(tryMount, 300);
          }
        };
        tryMount();
        return () => {
          cancelled = true;
          if (hostRef.current) {
            const host = hostRef.current;
            hostRef.current = null;
            host.remove();
          }
        };
      }, []);

      return e(react.Fragment, null,
        e("style", null, STYLES),
        e(RemoteControlModal, { visible: modalVisible, onClose: () => setModalVisible(false) })
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
