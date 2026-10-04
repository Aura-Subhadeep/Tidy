/* ============================================================
 * Tidy - popup script
 * Two-page UI: Home + Settings. Web Awesome (Awesome theme).
 * ============================================================ */

import './vendor/webawesome/dist-cdn/components/button/button.js';
import './vendor/webawesome/dist-cdn/components/input/input.js';
import './vendor/webawesome/dist-cdn/components/switch/switch.js';
import './vendor/webawesome/dist-cdn/components/dialog/dialog.js';
import './vendor/webawesome/dist-cdn/components/checkbox/checkbox.js';
import './vendor/webawesome/dist-cdn/components/tooltip/tooltip.js';
import './vendor/webawesome/dist-cdn/components/icon/icon.js';

import { setBasePath, registerIconLibrary } from './vendor/webawesome/dist-cdn/webawesome.js';
setBasePath('vendor/webawesome/dist-cdn/');

// Local stroke-icon library (icons/*.svg), sized to match system icons.
registerIconLibrary('lucide', {
  resolver: (name) => `icons/${name}.svg`,
  mutator: (svg) => {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('width', '1em');
    svg.setAttribute('height', '1em');
    svg.removeAttribute('class');
  },
});

const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  breakInterval: 15,
  breakDuration: 5,
  autoRepeatBreaks: true,
  soundEnabled: true,
  fullscreenBreak: true,
  dailyGoalHours: 4,
  showDailyGoal: true,
  showWeeklyCompare: true,
};

const SKIP_LIMIT = 3; // mirrors SKIP_LIMIT in background.js

const DEFAULT_STATE = {
  running: false,
  sessionStart: null,
  sessionStartedAt: null,
  accumulatedMs: 0,
  paused: false,
  nextBreakAt: null,
  breakMode: false,
  breakRemainingMs: null,
  currentBreakEndsAt: null,
  lastSeenAt: null,
};

const ICONS = {
  play: '<wa-icon slot="start" library="system" name="play" label=""></wa-icon>',
  pause: '<wa-icon slot="start" library="system" name="pause" label=""></wa-icon>',
  stop: '<wa-icon slot="start" library="lucide" name="square" label=""></wa-icon>',
  skip: '<wa-icon slot="start" library="system" name="forward-step" label=""></wa-icon>',
};

async function getSettings() {
  const data = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

async function getState() {
  const data = await chrome.storage.local.get('state');
  return { ...DEFAULT_STATE, ...(data.state || {}) };
}

function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function monthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Display only: the background owns the counter and is the sole writer.
async function getSkips() {
  const { skips } = await chrome.storage.local.get('skips');
  const month = monthKey();
  if (!skips || skips.month !== month) return { month, used: 0 };
  return { month, used: Math.max(0, skips.used | 0) };
}

function last7DayKeys() {
  const out = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

function shortDayLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}

async function getHistory() {
  const data = await chrome.storage.local.get('history');
  return data.history || {};
}

function sendMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (resp) => resolve(resp));
  });
}

function fmtTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return {
    h: String(h).padStart(2, '0'),
    m: String(m).padStart(2, '0'),
    s: String(s).padStart(2, '0'),
  };
}

function fmtHM(ms) {
  const total = Math.floor(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function fmtClock(epochMs) {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function fmtBreakCountdown(ms) {
  if (ms <= 0) return 'now';
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getSessionStatus(state) {
  if (!state.running) return 'idle';
  if (state.breakMode) return 'break';
  return state.paused ? 'paused' : 'running';
}

// Elapsed time of the active session, live: accumulated segments plus
// the current one. sessionStartedAt (not sessionStart) survives
// pause/resume cycles and anchors the "Session started" clock.
function currentElapsedMs(state) {
  if (!state.running) return 0;
  if (state.paused) return state.accumulatedMs;
  return state.accumulatedMs + (state.sessionStart ? Date.now() - state.sessionStart : 0);
}

function calculateWeeklyCompare(history) {
  const today = new Date();
  let thisMs = 0, lastMs = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    thisMs += history[dayKey(d)]?.totalMs || 0;
  }
  for (let i = 7; i < 14; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    lastMs += history[dayKey(d)]?.totalMs || 0;
  }
  let pct = 0;
  if (lastMs > 0) {
    pct = ((thisMs - lastMs) / lastMs) * 100;
  } else if (thisMs > 0) {
    pct = 100;
  }
  return { thisMs, lastMs, pct };
}

let liveTimer = null;

function renderStatus(state) {
  const pill = $('statusPill');
  const text = $('statusText');
  pill.classList.remove('active', 'break-mode', 'paused-mode');
  const status = getSessionStatus(state);
  if (status === 'break') {
    pill.classList.add('break-mode');
    text.textContent = 'On a break';
  } else if (status === 'paused') {
    pill.classList.add('paused-mode');
    text.textContent = 'Paused';
  } else if (status === 'running') {
    pill.classList.add('active');
    text.textContent = 'Focusing';
  } else {
    text.textContent = 'Ready to focus';
  }
}

function renderTimer(state) {
  const t = fmtTime(currentElapsedMs(state));
  $('timerHours').textContent = t.h;
  $('timerMinutes').textContent = t.m;
  $('timerSeconds').textContent = t.s;

  const sessionInfo = $('sessionInfo');
  if (state.running && state.sessionStartedAt) {
    sessionInfo.classList.remove('hidden');
    $('sessionStart').textContent = fmtClock(state.sessionStartedAt);
  } else {
    sessionInfo.classList.add('hidden');
  }
}

function renderBreakReminder(state, settings) {
  const reminder = $('breakReminder');
  const skipRow = $('breakSkip');
  if (!state.running) {
    reminder.classList.add('hidden');
    skipRow.hidden = true;
    return;
  }

  if (state.breakMode) {
    // Inside a break: count down to the break's authoritative end time.
    reminder.classList.remove('hidden');
    skipRow.hidden = false;
    const label = document.querySelector('.break-reminder-label');
    if (label) label.textContent = 'Break ends in';
    if (state.paused) {
      $('breakCountdown').textContent = 'Paused';
      return;
    }
    const msLeft = state.currentBreakEndsAt
      ? state.currentBreakEndsAt - Date.now()
      : settings.breakDuration * 60 * 1000;
    $('breakCountdown').textContent = fmtBreakCountdown(Math.max(0, msLeft));
    return;
  }

  skipRow.hidden = true;
  const label = document.querySelector('.break-reminder-label');
  if (label) label.textContent = 'Next break in';
  reminder.classList.remove('hidden');
  if (state.paused) {
    $('breakCountdown').textContent = 'Paused';
    return;
  }
  if (!state.nextBreakAt) {
    $('breakCountdown').textContent = `${settings.breakInterval}m`;
    return;
  }
  // Always derived from the authoritative nextBreakAt timestamp and the
  // current time; callers pass freshly read state on every 1s tick, so
  // this can never drift from the main elapsed timer.
  const remaining = state.nextBreakAt - Date.now();
  $('breakCountdown').textContent = fmtBreakCountdown(remaining);
}

function skipsRemaining(skips) {
  return Math.max(0, SKIP_LIMIT - skips.used);
}

function renderSkips(skips) {
  const remaining = skipsRemaining(skips);
  const el = $('skipsLeft');
  if (remaining === 0) {
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
    const name = nextMonth.toLocaleDateString(undefined, { month: 'long' });
    el.textContent = `No skips left this month · resets ${name} 1`;
  } else {
    el.textContent = `${remaining} skip${remaining === 1 ? '' : 's'} left this month`;
  }
}

function renderControls(state, skips) {
  const status = getSessionStatus(state);
  const primary = $('primaryBtn');
  const end = $('endBtn');
  if (status === 'idle') {
    primary.innerHTML = ICONS.play + '<span>Start Session</span>';
    primary.disabled = false;
    end.disabled = true;
  } else if (status === 'running') {
    primary.innerHTML = ICONS.pause + '<span>Pause Session</span>';
    primary.disabled = false;
    end.disabled = false;
  } else if (status === 'paused') {
    primary.innerHTML = ICONS.play + '<span>Resume Session</span>';
    primary.disabled = false;
    end.disabled = false;
  } else if (status === 'break') {
    // The primary action doubles as the skip during a break.
    primary.innerHTML = ICONS.skip + '<span>Skip break</span>';
    primary.disabled = skipsRemaining(skips) === 0;
    end.disabled = false;
  }
}

function renderGoal(history, settings, state) {
  // Live goal progress includes the current running session's time.
  const totalMs = (history[dayKey()]?.totalMs || 0) + currentElapsedMs(state);
  const targetMs = settings.dailyGoalHours * 3600000;
  const pct = Math.min(100, targetMs > 0 ? (totalMs / targetMs) * 100 : 0);
  $('goalCurrent').textContent = fmtHM(totalMs);
  $('goalTargetDisplay').textContent = `${settings.dailyGoalHours}hrs`;
  $('goalPercent').textContent = `${Math.round(pct)}%`;
  $('goalFill').style.width = pct + '%';
  $('goalCard').classList.toggle('met', totalMs >= targetMs && targetMs > 0);
}

function renderCompare(history) {
  const { thisMs, lastMs, pct } = calculateWeeklyCompare(history);
  const valueEl = $('compareValue');
  const detailEl = $('compareDetail');
  valueEl.classList.remove('positive', 'negative');
  if (lastMs === 0 && thisMs === 0) {
    valueEl.textContent = '—';
    detailEl.textContent = 'No data yet';
  } else if (lastMs === 0) {
    valueEl.textContent = 'NEW';
    valueEl.classList.add('positive');
    detailEl.textContent = `${fmtHM(thisMs)} this week`;
  } else {
    const sign = pct > 0 ? '+' : '';
    valueEl.textContent = `${sign}${Math.round(pct)}%`;
    if (pct > 0) valueEl.classList.add('positive');
    else if (pct < 0) valueEl.classList.add('negative');
    detailEl.textContent = `${fmtHM(thisMs)} vs ${fmtHM(lastMs)}`;
  }
}

async function renderStats(history, state) {
  const todayMs = (history[dayKey()]?.totalMs || 0) + currentElapsedMs(state);
  const todaySessions = history[dayKey()]?.sessions || 0;
  $('todayTotal').textContent = fmtHM(todayMs);
  $('todaySessions').textContent = `${todaySessions} session${todaySessions === 1 ? '' : 's'}`;

  const keys = last7DayKeys();
  let weekMs = 0, weekSessions = 0;
  keys.forEach(k => {
    if (history[k]) {
      weekMs += history[k].totalMs;
      weekSessions += history[k].sessions;
    }
  });
  $('weekTotal').textContent = fmtHM(weekMs);
  $('weekSessions').textContent = `${weekSessions} session${weekSessions === 1 ? '' : 's'}`;

  const maxMs = Math.max(...keys.map(k => (history[k]?.totalMs || 0)), 60 * 60 * 1000);
  const chart = $('barChart');
  const labels = $('barLabels');
  chart.innerHTML = '';
  labels.innerHTML = '';
  keys.forEach((k, i) => {
    const ms = history[k]?.totalMs || 0;
    const bar = document.createElement('div');
    bar.className = 'bar';
    if (ms === 0) bar.classList.add('empty');
    if (i === keys.length - 1) bar.classList.add('today');
    const pct = Math.min(100, Math.max(3, (ms / maxMs) * 100));
    bar.style.height = pct + '%';
    bar.title = `${k}: ${fmtHM(ms)}`;
    chart.appendChild(bar);

    const lbl = document.createElement('span');
    if (i === keys.length - 1) lbl.classList.add('today');
    lbl.textContent = shortDayLabel(k);
    labels.appendChild(lbl);
  });

  const avgMs = weekMs / 7;
  $('historyAvg').textContent = `Avg ${fmtHM(avgMs)}/day`;
}

function applyFeatureVisibility(settings) {
  $('goalCard').hidden = !settings.showDailyGoal;
  $('compareCard').hidden = !settings.showWeeklyCompare;
}

function renderSettingsInputs(settings) {
  $('breakInterval').value = settings.breakInterval;
  $('breakDuration').value = settings.breakDuration;
  $('autoRepeatBreaks').checked = settings.autoRepeatBreaks;
  $('soundEnabled').checked = settings.soundEnabled;
  $('fullscreenBreak').checked = settings.fullscreenBreak;
  $('dailyGoalHours').value = settings.dailyGoalHours;
  $('showDailyGoal').checked = settings.showDailyGoal;
  $('showWeeklyCompare').checked = settings.showWeeklyCompare;
}

async function refresh() {
  // Opening the popup may be the first code to run after a browser restart.
  await sendMessage({ type: 'RECONCILE' });

  const state = await getState();
  const settings = await getSettings();
  const history = await getHistory();
  const skips = await getSkips();

  renderStatus(state);
  renderTimer(state);
  renderControls(state, skips);
  renderBreakReminder(state, settings);
  renderSkips(skips);

  applyFeatureVisibility(settings);
  if (settings.showDailyGoal) renderGoal(history, settings, state);
  if (settings.showWeeklyCompare) renderCompare(history);

  await renderStats(history, state);

  // Safety net: restart the tick if a stale state read ever stopped it
  // while the session is still running in the background.
  if (state.running && !state.paused && !liveTimer) {
    startLiveTimer();
  }
}

function showPage(pageName) {
  $('homePage').hidden = pageName !== 'home';
  $('settingsPage').hidden = pageName !== 'settings';
  $('headerHome').hidden = pageName !== 'home';
  $('headerSettings').hidden = pageName !== 'settings';
}

async function handlePrimaryClick() {
  const state = await getState();
  const status = getSessionStatus(state);
  if (status === 'idle') {
    await sendMessage({ type: 'START_SESSION' });
    startLiveTimer();
  } else if (status === 'running') {
    await sendMessage({ type: 'PAUSE_SESSION' });
  } else if (status === 'paused') {
    await sendMessage({ type: 'RESUME_SESSION' });
    startLiveTimer();
  } else if (status === 'break') {
    await handleSkip();
    return;
  } else {
    return;
  }
  await refresh();
}

async function handleEnd() {
  await sendMessage({ type: 'STOP_SESSION' });
  stopLiveTimer();
  await refresh();
}

async function handleSkip() {
  $('primaryBtn').disabled = true; // block a double click while the reply is in flight
  await sendMessage({ type: 'SKIP_BREAK' });
  await refresh(); // re-reads the counter; the background has already broadcast
}

function startLiveTimer() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(async () => {
    const state = await getState();
    renderTimer(state);
    if (!state.running) {
      stopLiveTimer();
      return;
    }
    const settings = await getSettings();
    renderBreakReminder(state, settings);
    if (state.breakMode) {
      const skips = await getSkips();
      renderSkips(skips);
      renderControls(state, skips);
    }
  }, 1000);
}

function stopLiveTimer() {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
}

async function handleSettingChange() {
  const settings = await getSettings();
  settings.breakInterval = Math.max(1, Math.min(120, parseInt($('breakInterval').value) || 15));
  settings.breakDuration = Math.max(1, Math.min(30, parseInt($('breakDuration').value) || 5));
  settings.autoRepeatBreaks = $('autoRepeatBreaks').checked;
  settings.soundEnabled = $('soundEnabled').checked;
  settings.fullscreenBreak = $('fullscreenBreak').checked;
  settings.dailyGoalHours = Math.max(1, Math.min(16, parseInt($('dailyGoalHours').value) || 4));
  settings.showDailyGoal = $('showDailyGoal').checked;
  settings.showWeeklyCompare = $('showWeeklyCompare').checked;
  await saveSettings(settings);
  await sendMessage({ type: 'SETTINGS_UPDATED' });
  await refresh();
}

async function handleClear() {
  if (!confirm('Erase all your work history? This cannot be undone.')) return;
  await chrome.storage.local.remove('history');
  await refresh();
}

async function handleExportBackup() {
  const data = await chrome.storage.local.get(null);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tidy-backup-${dayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let pendingImportData = null;

async function handleImportFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('Invalid backup file format — expected a JSON object.');
    }
    const hasSettings = data.settings && typeof data.settings === 'object';
    const hasHistory = data.history && typeof data.history === 'object';
    if (!hasSettings && !hasHistory) {
      throw new Error('Backup file does not contain any recognizable settings or history data.');
    }

    const settingsCheckbox = $('restoreSettings');
    const dataCheckbox = $('restoreData');

    settingsCheckbox.checked = hasSettings;
    settingsCheckbox.disabled = !hasSettings;
    $('restoreSettingsDesc').textContent = hasSettings
      ? 'Break interval, daily goal, feature toggles'
      : 'Not present in this backup file';

    dataCheckbox.checked = hasHistory;
    dataCheckbox.disabled = !hasHistory;
    $('restoreDataDesc').textContent = hasHistory
      ? 'Your work sessions and daily totals'
      : 'Not present in this backup file';

    pendingImportData = data;
    $('importModal').open = true;
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
}

async function handleImportConfirm() {
  if (!pendingImportData) return;

  const restoreSettings = $('restoreSettings').checked;
  const restoreData = $('restoreData').checked;

  if (!restoreSettings && !restoreData) {
    alert('Please select at least one item to restore.');
    return;
  }

  try {
    if (restoreSettings && pendingImportData.settings) {
      await chrome.storage.local.set({ settings: pendingImportData.settings });
    }
    if (restoreData && pendingImportData.history) {
      await chrome.storage.local.set({ history: pendingImportData.history });
    }
    $('importModal').open = false;
    pendingImportData = null;
    alert('Backup restored successfully! The extension will now reload.');
    chrome.runtime.reload();
  } catch (err) {
    alert('Restore failed: ' + err.message);
  }
}

function handleImportCancel() {
  $('importModal').open = false;
  pendingImportData = null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'STATE_CHANGED') {
    refresh();
    sendResponse({ ok: true });
  }
  return true;
});

document.addEventListener('DOMContentLoaded', async () => {
  $('goToSettings').addEventListener('click', () => showPage('settings'));
  $('goBackHome').addEventListener('click', () => showPage('home'));
  $('primaryBtn').addEventListener('click', handlePrimaryClick);
  $('endBtn').addEventListener('click', handleEnd);

  ['breakInterval', 'breakDuration', 'autoRepeatBreaks', 'soundEnabled',
   'fullscreenBreak', 'dailyGoalHours', 'showDailyGoal', 'showWeeklyCompare'
  ].forEach(id => {
    $(id).addEventListener('change', handleSettingChange);
  });
  $('exportBackup').addEventListener('click', handleExportBackup);
  $('importBackup').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', handleImportFileChange);
  $('importConfirm').addEventListener('click', handleImportConfirm);
  $('importCancel').addEventListener('click', handleImportCancel);
  $('importModal').addEventListener('wa-hide', () => {
    pendingImportData = null;
  });
  $('clearData').addEventListener('click', handleClear);

  const settings = await getSettings();
  renderSettingsInputs(settings);

  showPage('home');
  await refresh();
  document.body.classList.add('ready');

  // First paint must show the popup fully rendered, so transitions are
  // suppressed until two frames in; later state changes animate normally.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove('suppress-anim');
    });
  });

  const state = await getState();
  if (state.running && !state.paused) startLiveTimer();
});
