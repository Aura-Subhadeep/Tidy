/* ============================================================
 * Tidy - full-screen break clock
 * Countdown is always derived from the stored break end time, so it
 * cannot drift from the break the background scheduled.
 * ============================================================ */

import './vendor/webawesome/dist-cdn/components/button/button.js';
import './vendor/webawesome/dist-cdn/components/tooltip/tooltip.js';
import './vendor/webawesome/dist-cdn/components/icon/icon.js';

import { setBasePath } from './vendor/webawesome/dist-cdn/webawesome.js';
setBasePath('vendor/webawesome/dist-cdn/');

const DEFAULT_SETTINGS = { breakDuration: 5 };
const DEFAULT_STATE = { breakMode: false, currentBreakEndsAt: null, paused: false };
const SKIP_LIMIT = 3; // mirrors SKIP_LIMIT in background.js

const $ = (id) => document.getElementById(id);

function sendMessage(payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return { ...DEFAULT_STATE, ...(state || {}) };
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Same lazy month comparison the background uses: a key from an earlier
// month reads as a fresh allowance.
async function getSkips() {
  const { skips } = await chrome.storage.local.get('skips');
  const month = monthKey();
  if (!skips || skips.month !== month) return { month, used: 0 };
  return { month, used: Math.max(0, skips.used | 0) };
}

function fmtClock(epochMs) {
  const d = new Date(epochMs);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

// Drop the tracked id before closing: otherwise the background sees its
// own window disappear while the break is still active and reopens it.
async function closeSelf() {
  try {
    await chrome.storage.session.remove('breakWindowId');
    const win = await chrome.windows.getCurrent();
    await chrome.windows.remove(win.id);
  } catch (e) {
    console.error('Tidy break error:', e);
  }
}

function render(state, settings) {
  const totalMs = settings.breakDuration * 60 * 1000;
  const endsAt = state.currentBreakEndsAt;
  const remainingMs = endsAt ? Math.max(0, endsAt - Date.now()) : totalMs;

  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  $('breakClock').textContent = `${m}:${String(s).padStart(2, '0')}`;

  const pct = totalMs > 0 ? Math.min(100, Math.max(0, (1 - remainingMs / totalMs) * 100)) : 0;
  $('breakProgressFill').style.width = pct + '%';

  $('breakEndsAt').textContent = endsAt ? fmtClock(endsAt) : '—';
}

async function tick() {
  const state = await getState();
  if (!state.breakMode) {
    await closeSelf();
    return;
  }
  if (state.currentBreakEndsAt && Date.now() >= state.currentBreakEndsAt) {
    await closeSelf();
    return;
  }
  render(state, await getSettings());
}

function renderSkips(skips) {
  const remaining = Math.max(0, SKIP_LIMIT - skips.used);
  const el = $('skipsLeft');
  if (remaining === 0) {
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
    const name = nextMonth.toLocaleDateString(undefined, { month: 'long' });
    el.textContent = `No skips left this month · resets ${name} 1`;
  } else {
    el.textContent = `${remaining} skip${remaining === 1 ? '' : 's'} left this month`;
  }
  $('skipBtn').disabled = remaining === 0;
}

async function refreshSkips() {
  renderSkips(await getSkips());
}

async function handleSkip() {
  const btn = $('skipBtn');
  btn.disabled = true; // block a double click while the reply is in flight
  const res = await sendMessage({ type: 'SKIP_BREAK' });
  if (res && res.ok) return; // the break ended; tick() closes the window
  renderSkips(await getSkips());
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'STATE_CHANGED') {
    tick();
    refreshSkips();
    sendResponse({ ok: true });
  }
  return true;
});

document.addEventListener('DOMContentLoaded', async () => {
  $('skipBtn').addEventListener('click', handleSkip);
  await refreshSkips();
  await tick();
  document.body.classList.add('ready');
  setInterval(tick, 1000);
});