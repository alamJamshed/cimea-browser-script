// ==UserScript==
// @name         CIMEA Timed Click
// @namespace    https://github.com/alamJamshed/cimea-browser-script
// @version      0.1.1
// @description  Clicks a chosen button at an exact time (Europe/Rome), synced to the server's clock.
// @match        *://mywallet.cimea-diplome.it/*
// @downloadURL  https://raw.githubusercontent.com/alamJamshed/cimea-browser-script/main/cimea-timed-click.user.js
// @updateURL    https://raw.githubusercontent.com/alamJamshed/cimea-browser-script/main/cimea-timed-click.user.js
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------- config

  const TIME_ZONE = 'Europe/Rome'; // CEST in summer, CET in winter — handled automatically
  const PRESETS = [
    { label: 'W1', time: '14:59:55' },
    { label: 'W2', time: '14:59:58' },
    { label: 'W3', time: '15:00:00' },
  ];
  // Optional: CSS selector of the button. Leave empty and use "Pick button" instead.
  const BUTTON_SELECTOR = '';
  const SYNC_SAMPLES = 8; // requests used to measure the server clock
  const SYNC_MAX_AGE_MS = 30 * 60 * 1000; // reuse a measurement from another tab for this long
  const WAIT_FOR_ENABLED_MS = 10000; // if the button is disabled at fire time, keep retrying this long

  const LS_SELECTOR = 'cimeaTimer.selector';
  const LS_SYNC = 'cimeaTimer.sync';
  const SS_LAST = 'cimeaTimer.lastResult';

  // ---------------------------------------------------------------- time

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  function zonedParts(ms) {
    const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
  }

  function tzOffsetMs(ms) {
    const p = zonedParts(ms);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  }

  // Wall-clock time in TIME_ZONE -> epoch ms.
  function zonedToEpoch(y, mo, d, h, mi, s) {
    const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
    let t = asUtc;
    for (let i = 0; i < 2; i++) t = asUtc - tzOffsetMs(t);
    return t;
  }

  // Next time the wall clock in TIME_ZONE shows `timeStr` (HH:MM:SS), strictly after `afterMs`.
  function nextOccurrence(timeStr, afterMs) {
    const [h, mi, s = 0] = timeStr.split(':').map(Number);
    const today = zonedParts(afterMs);
    for (let add = 0; add < 3; add++) {
      const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + add));
      const t = zonedToEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, s);
      if (t > afterMs) return t;
    }
    return NaN;
  }

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function fmt(ms) {
    const p = zonedParts(ms);
    return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}.${pad(((ms % 1000) + 1000) % 1000 | 0, 3)}`;
  }
  function fmtDuration(ms) {
    const sign = ms < 0 ? '-' : '';
    ms = Math.abs(ms);
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = (ms / 1000) % 60;
    return sign + (h ? `${h}:${pad(m)}:` : m ? `${m}:` : '') + (h || m ? s.toFixed(1).padStart(4, '0') : s.toFixed(1));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

  // ---------------------------------------------------------------- server clock sync
  //
  // Each response's Date header (1 s resolution) was produced at some server time in
  // [date, date + 1000) while our clock was in [t0, t1]. So offset = server - local lies in
  // [date - t1, date + 1000 - t0]. Intersecting samples narrows it; each request is timed to
  // hit the server exactly on a second boundary per the current estimate (a bisection),
  // which converges to roughly the network round-trip time.

  let sync = null; // { lo, hi, rtt, at }
  const offset = () => (sync.lo + sync.hi) / 2;
  const serverNow = () => Date.now() + (sync ? offset() : 0);

  async function sample() {
    const t0 = Date.now();
    const res = await fetch(`${location.origin}/?_cimeaTimer=${Math.random()}`, {
      method: 'HEAD', cache: 'no-store', credentials: 'same-origin',
    });
    const t1 = Date.now();
    const date = Date.parse(res.headers.get('date'));
    if (Number.isNaN(date)) throw new Error('server sent no Date header');
    return { t0, t1, date };
  }

  async function measureClock(onProgress) {
    let lo = -Infinity, hi = Infinity;
    const rtts = [];
    for (let i = 0; i < SYNC_SAMPLES; i++) {
      if (i > 0) {
        const half = median(rtts) / 2, mid = (lo + hi) / 2, now = Date.now();
        const boundary = Math.ceil((now + 50 + half + mid) / 1000) * 1000;
        await sleep(boundary - half - mid - now);
      }
      const s = await sample();
      rtts.push(s.t1 - s.t0);
      const nlo = Math.max(lo, s.date - s.t1), nhi = Math.min(hi, s.date + 1000 - s.t0);
      if (nlo <= nhi) { lo = nlo; hi = nhi; } // else: inconsistent sample (e.g. cached), ignore
      onProgress(i + 1, lo, hi);
    }
    return { lo, hi, rtt: median(rtts), at: Date.now() };
  }

  function loadSharedSync() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_SYNC));
      if (s && Date.now() - s.at < SYNC_MAX_AGE_MS) return s;
    } catch (_) { /* ignore */ }
    return null;
  }

  async function doSync(force) {
    if (!force && (sync || (sync = loadSharedSync()))) return;
    ui.setSync('Syncing with server clock…');
    try {
      sync = await measureClock((n, lo, hi) =>
        ui.setSync(`Syncing ${n}/${SYNC_SAMPLES}… ±${Math.round((hi - lo) / 2)} ms`));
      try { localStorage.setItem(LS_SYNC, JSON.stringify(sync)); } catch (_) { /* ignore */ }
    } catch (e) {
      sync = { lo: 0, hi: 0, rtt: NaN, at: Date.now(), failed: true };
      ui.setSync(`Sync failed (${e.message}) — using PC clock`, true);
      return;
    }
  }

  // ---------------------------------------------------------------- target element

  function cssPath(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id) { parts.unshift(`#${CSS.escape(el.id)}`); return parts.join(' > '); }
      let part = el.tagName.toLowerCase();
      const parent = el.parentElement;
      const same = parent ? [...parent.children].filter((c) => c.tagName === el.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      parts.unshift(part);
      el = parent;
    }
    return ['body', ...parts].join(' > ');
  }

  let targetEl = null, targetSelector = null;

  function setTarget(el) {
    if (targetEl) targetEl.style.outline = targetEl.dataset.cimeaOutline || '';
    targetEl = el;
    if (!el) { ui.setTarget(null); return; }
    targetSelector = cssPath(el);
    try { localStorage.setItem(LS_SELECTOR, targetSelector); } catch (_) { /* ignore */ }
    el.dataset.cimeaOutline = el.style.outline;
    el.style.outline = '3px dashed #e8590c';
    ui.setTarget(el);
  }

  function resolveTarget() {
    if (targetEl && targetEl.isConnected) return targetEl;
    return targetSelector ? document.querySelector(targetSelector) : null;
  }

  function startPicking() {
    ui.setStatus('Click the button this tab should press…');
    let hovered = null;
    const unhover = () => { if (hovered) hovered.style.outline = hovered.dataset.cimeaHover || ''; hovered = null; };
    const block = (e) => {
      if (ui.contains(e.target)) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    };
    const onOver = (e) => {
      if (ui.contains(e.target) || e.target === targetEl) return;
      unhover();
      hovered = e.target;
      hovered.dataset.cimeaHover = hovered.style.outline;
      hovered.style.outline = '2px solid #1c7ed6';
    };
    const onClick = (e) => {
      if (ui.contains(e.target)) return;
      block(e);
      unhover();
      for (const [t, f] of handlers) document.removeEventListener(t, f, true);
      setTarget(e.target.closest('button, input[type=submit], input[type=button], a, [role=button]') || e.target);
      ui.setStatus('Button selected. Now arm this tab.');
    };
    const handlers = [['mouseover', onOver], ['pointerdown', block], ['mousedown', block], ['mouseup', block], ['click', onClick]];
    for (const [t, f] of handlers) document.addEventListener(t, f, true);
  }

  // ---------------------------------------------------------------- scheduling
  //
  // Background tabs get their timers throttled to >= 1 s by Firefox; worker timers are not.
  // The worker sleeps until ~20 ms before the target, spins until the exact ms, then keeps
  // sending ticks so a disabled button can be retried from a background tab.

  const WORKER_SRC = `
    let timer = null, ticker = null;
    onmessage = (e) => {
      clearTimeout(timer); clearInterval(ticker);
      if (e.data.cmd !== 'arm') return;
      const target = e.data.target;
      const loop = () => {
        const rem = target - Date.now();
        if (rem > 25) { timer = setTimeout(loop, rem > 1000 ? Math.min(rem - 500, 30000) : rem - 20); return; }
        while (Date.now() < target) {}
        postMessage('fire');
        ticker = setInterval(() => postMessage('tick'), 10);
      };
      loop();
    };`;

  let worker = null;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
    worker.onmessage = (e) => (e.data === 'fire' ? fire('worker') : tryClick());
  } catch (_) {
    worker = null; // e.g. blocked by the site's CSP — fall back to main-thread timers
  }

  const state = { armed: false, fired: false, clicked: false, label: '', targetServer: 0, targetLocal: 0 };
  let backupTimer = null, fallbackPoll = null;

  async function arm(timeStr, label) {
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(timeStr)) return ui.setStatus('Time must be HH:MM:SS', true);
    if (!resolveTarget()) return ui.setStatus('Pick the button first.', true);
    disarm(true);
    await doSync(false);
    Object.assign(state, { armed: true, fired: false, clicked: false, label: label || timeStr });
    state.targetServer = nextOccurrence(timeStr, serverNow());
    state.targetLocal = state.targetServer - offset();
    if (worker) worker.postMessage({ cmd: 'arm', target: state.targetLocal });
    backupTimer = setTimeout(() => fire('timer'), state.targetLocal - Date.now());
    const tomorrow = zonedParts(state.targetServer).d !== zonedParts(serverNow()).d;
    ui.setStatus(`Armed ${state.label}: clicking at ${fmt(state.targetServer)}${tomorrow ? ' TOMORROW' : ''} (Rome time)` +
      (worker ? '' : ' — worker blocked, keep this tab in front'));
    ui.render();
  }

  function disarm(silent) {
    if (worker) worker.postMessage({ cmd: 'stop' });
    clearTimeout(backupTimer);
    clearInterval(fallbackPoll);
    state.armed = false;
    if (!silent) ui.setStatus('Disarmed.');
    ui.render();
  }

  function fire(source) {
    if (!state.armed || state.fired) return;
    state.fired = true;
    state.source = source;
    if (!tryClick() && !worker) fallbackPoll = setInterval(tryClick, 10);
  }

  function tryClick() {
    if (!state.armed || !state.fired || state.clicked) return true;
    const el = resolveTarget();
    const late = Date.now() - state.targetLocal;
    if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
      state.clicked = true;
      const msg = `${state.label}: clicked at ${fmt(serverNow())} server time (${late} ms after target, via ${state.source})`;
      try { sessionStorage.setItem(SS_LAST, msg); } catch (_) { /* ignore */ }
      console.log('[CIMEA timer]', msg);
      el.click();
      finish(msg);
      return true;
    }
    if (late > WAIT_FOR_ENABLED_MS) {
      finish(`${state.label}: gave up — button ${el ? 'stayed disabled' : 'not found'} for ${WAIT_FOR_ENABLED_MS / 1000}s`, true);
      return true;
    }
    return false;
  }

  function finish(msg, isError) {
    if (worker) worker.postMessage({ cmd: 'stop' });
    clearInterval(fallbackPoll);
    clearTimeout(backupTimer);
    state.armed = false;
    ui.setStatus(msg, isError);
    ui.render();
  }

  // ---------------------------------------------------------------- UI

  const ui = (() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .box { font: 13px/1.4 system-ui, sans-serif; color: #212529; background: #fff; width: 290px;
               border: 2px solid #adb5bd; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.2); }
        .box.armed { border-color: #2f9e44; }
        .box.done { border-color: #1c7ed6; }
        .hdr { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #f1f3f5; border-radius: 6px 6px 0 0; }
        .hdr b { flex: 1; }
        .clock { font-variant-numeric: tabular-nums; color: #495057; }
        .body { padding: 8px; display: grid; gap: 6px; }
        .box.min .body { display: none; }
        .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        button { font: inherit; padding: 3px 8px; border: 1px solid #adb5bd; border-radius: 4px; background: #fff; cursor: pointer; }
        button:hover { background: #e9ecef; }
        button.preset { font-weight: 600; }
        input { font: inherit; width: 80px; padding: 2px 4px; }
        .muted { color: #868e96; font-size: 12px; }
        .err { color: #c92a2a; }
        .count { font-size: 26px; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums; color: #2f9e44; }
        .target { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }
      </style>
      <div class="box">
        <div class="hdr"><b>CIMEA timer</b><span class="clock" id="clock"></span><button id="min">–</button></div>
        <div class="body">
          <div class="row"><button id="pick">Pick button</button><span class="target muted" id="target">none selected</span></div>
          <div class="row" id="presets"></div>
          <div class="row"><input id="time" value="${PRESETS[PRESETS.length - 1].time}"><button id="armCustom">Arm</button><button id="disarm">Disarm</button></div>
          <div class="count" id="count" hidden></div>
          <div id="status"></div>
          <div class="row"><span class="muted" id="sync">Clock not synced yet</span><button id="resync">Resync</button></div>
        </div>
      </div>`;
    const $ = (id) => root.getElementById(id);
    const box = root.querySelector('.box');
    const originalTitle = document.title;

    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.className = 'preset';
      b.textContent = `${p.label} ${p.time}`;
      b.onclick = () => arm(p.time, p.label);
      $('presets').append(b);
    }
    $('pick').onclick = startPicking;
    $('armCustom').onclick = () => arm($('time').value.trim(), '');
    $('disarm').onclick = () => disarm(false);
    $('resync').onclick = async () => { await doSync(true); if (state.armed && !state.fired) arm(zonedTimeStr(state.targetServer), state.label); };
    $('min').onclick = () => box.classList.toggle('min');

    function zonedTimeStr(ms) { const p = zonedParts(ms); return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`; }

    function render() {
      const now = serverNow();
      $('clock').textContent = zonedTimeStr(now);
      box.classList.toggle('armed', state.armed);
      box.classList.toggle('done', state.clicked);
      $('count').hidden = !state.armed;
      if (state.armed) {
        const rem = state.targetServer - now;
        $('count').textContent = rem > 0 ? fmtDuration(rem) : 'clicking…';
        document.title = `[${state.label} ${rem > 0 ? fmtDuration(rem) : '…'}] ${originalTitle}`;
      } else {
        document.title = state.clicked ? `[✓ ${state.label}] ${originalTitle}` : originalTitle;
      }
      if (sync && !sync.failed) {
        const ageMin = Math.round((Date.now() - sync.at) / 60000);
        $('sync').textContent = `PC clock ${offset() >= 0 ? 'behind' : 'ahead'} by ${Math.abs(offset() / 1000).toFixed(3)} s ` +
          `(±${Math.round((sync.hi - sync.lo) / 2)} ms, ping ${Math.round(sync.rtt)} ms, ${ageMin} min ago)`;
        $('sync').className = 'muted';
      }
    }
    setInterval(render, 100);

    document.documentElement.append(host);

    return {
      contains: (node) => node === host || host.contains(node),
      render,
      setTarget(el) {
        $('target').textContent = el ? (el.value || el.textContent || el.tagName).trim().slice(0, 60) || el.tagName : 'none selected';
        $('target').className = el ? 'target' : 'target muted';
      },
      setStatus(msg, isError) { $('status').textContent = msg; $('status').className = isError ? 'err' : ''; },
      setSync(msg, isError) { $('sync').textContent = msg; $('sync').className = isError ? 'err' : 'muted'; },
    };
  })();

  // ---------------------------------------------------------------- init

  const savedSelector = BUTTON_SELECTOR || (() => { try { return localStorage.getItem(LS_SELECTOR); } catch (_) { return null; } })();
  if (savedSelector) {
    const el = document.querySelector(savedSelector);
    if (el) setTarget(el);
  }
  try {
    const last = sessionStorage.getItem(SS_LAST);
    if (last) { ui.setStatus(`Last run: ${last}`); sessionStorage.removeItem(SS_LAST); }
  } catch (_) { /* ignore */ }
  sync = loadSharedSync();
  ui.render();
})();
