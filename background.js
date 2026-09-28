/* ============================================================
 * Tidy - background service worker
 * Manages: timer state, pause/resume, break reminders, live badge
 * ============================================================ */

const ALARM_BREAK = 'ff-break-alarm';
const ALARM_BREAK_TICK = 'ff-break-tick';
const ALARM_BADGE_TICK = 'ff-badge-tick';

const DEFAULT_SETTINGS = {
  breakInterval: 15,
  breakDuration: 5,
  autoRepeatBreaks: true,
  soundEnabled: true,
  dailyGoalHours: 4,
  showDailyGoal: true,
  showWeeklyCompare: true,
};

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
};

async function getState() {
  const { state = {} } = await chrome.storage.local.get('state');
  return { ...DEFAULT_STATE, ...state };
}

async function saveState(state) {
  await chrome.storage.local.set({ state });
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function addWorkMsToToday(ms, sessions = 0) {
  const { history = {} } = await chrome.storage.local.get('history');
  const key = dayKey();
  if (!history[key]) history[key] = { totalMs: 0, sessions: 0 };
  history[key].totalMs += ms;
  history[key].sessions += sessions;
  await chrome.storage.local.set({ history });
}

function fmtBadgeTime(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) return `${h}h`;
  return `${h}h${m}`;
}

async function updateBadge() {
  const state = await getState();
  if (!state.running) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Tidy' });
    return;
  }
  if (state.breakMode) {
    chrome.action.setBadgeText({ text: 'BRK' });
    chrome.action.setBadgeBackgroundColor({ color: '#818cf8' });
    chrome.action.setTitle({ title: 'Tidy — On a break' });
    return;
  }
  let elapsed = state.accumulatedMs;
  if (state.sessionStart && !state.paused) {
    elapsed += Date.now() - state.sessionStart;
  }
  chrome.action.setBadgeText({ text: fmtBadgeTime(elapsed) });
  chrome.action.setBadgeBackgroundColor({
    color: state.paused ? '#5b6b85' : '#22d3ee',
  });
  chrome.action.setTitle({
    title: state.paused ? 'Tidy — Paused' : 'Tidy — Focusing',
  });
}

// The popup only listens while open; chrome.runtime.lastError swallows
// the "no receiver" error the rest of the time.
async function notifyStateChanged() {
  try {
    chrome.runtime.sendMessage({ type: 'STATE_CHANGED' }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
  await updateBadge();
}

async function scheduleNextBreak(fromMs = Date.now()) {
  const settings = await getSettings();
  const state = await getState();
  state.nextBreakAt = fromMs + settings.breakInterval * 60 * 1000;
  state.breakRemainingMs = null;
  await saveState(state);

  await chrome.alarms.clear(ALARM_BREAK);
  chrome.alarms.create(ALARM_BREAK, {
    // Fire at the exact stored timestamp so the alarm always agrees
    // with the countdown the popup derives from state.nextBreakAt.
    when: state.nextBreakAt,
    periodInMinutes: settings.autoRepeatBreaks ? settings.breakInterval : undefined,
  });
}

// Reschedule with the exact remaining ms so pause cycles don't reset
// break progress. Chrome enforces a ~0.5 min alarm minimum in prod.
async function scheduleBreakWithRemaining(remainingMs) {
  const settings = await getSettings();
  const now = Date.now();
  const state = await getState();
  state.nextBreakAt = now + remainingMs;
  state.breakRemainingMs = null;
  await saveState(state);

  await chrome.alarms.clear(ALARM_BREAK);
  chrome.alarms.create(ALARM_BREAK, {
    when: state.nextBreakAt,
    periodInMinutes: settings.autoRepeatBreaks ? settings.breakInterval : undefined,
  });
}

async function notifyBreak() {
  const settings = await getSettings();
  const state = await getState();
  if (!state.running || state.paused) return;

  state.breakMode = true;
  // Anchor the break end to nextBreakAt on the session timeline, NOT to
  // the alarm's fire time (Date.now() here can lag nextBreakAt by the
  // worker-wake latency, which previously made the countdown show one
  // extra second versus the main timer).
  state.currentBreakEndsAt = (state.nextBreakAt || Date.now()) + settings.breakDuration * 60 * 1000;
  await saveState(state);
  await notifyStateChanged();

  // Schedule the break's end BEFORE showing the notification so the
  // break always ends on time even if the notification fails.
  await chrome.alarms.clear(ALARM_BREAK_TICK);
  chrome.alarms.create(ALARM_BREAK_TICK, {
    when: state.currentBreakEndsAt,
  });

  try {
    await chrome.notifications.create('ff-break-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/logo/icon128.png',
      title: 'Time for a break!',
      message: `You've focused for ${settings.breakInterval} min. Take a ${settings.breakDuration} min break — stretch, look away from the screen, drink water.`,
      priority: 2,
    });
  } catch (e) {
    console.error('Tidy background error:', e);
  }

  await playSound('break');
}

async function endBreak(resumeWork = true) {
  const state = await getState();
  if (!state.breakMode) return;
  state.breakMode = false;
  state.currentBreakEndsAt = null;
  await saveState(state);
  await chrome.alarms.clear(ALARM_BREAK_TICK);

  if (resumeWork && state.running && !state.paused) {
    await scheduleNextBreak();
  }
  await notifyStateChanged();
}

// Sound is played through an offscreen document: service workers have
// no audio APIs, and the popup is usually closed when reminders fire.
async function hasOffscreenDoc() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function playSound(kind) {
  const settings = await getSettings();
  if (!settings.soundEnabled) return;

  try {
    if (!(await hasOffscreenDoc())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play break reminder chimes',
      });
    }
    chrome.runtime.sendMessage({ type: 'PLAY_SOUND', kind }).catch(() => {});
  } catch (e) {
    // The document may already exist from a concurrent call; the chime
    // is then delivered by the sendMessage above.
    if (!String(e).includes('single offscreen document')) {
      console.error('Tidy background error:', e);
    }
  }
}

async function startSession() {
  const now = Date.now();
  const state = {
    running: true,
    sessionStart: now,
    sessionStartedAt: now,
    accumulatedMs: 0,
    paused: false,
    nextBreakAt: null,
    breakMode: false,
    breakRemainingMs: null,
  };
  await saveState(state);

  await chrome.alarms.clear(ALARM_BREAK_TICK);
  await scheduleNextBreak(now);

  await chrome.alarms.clear(ALARM_BADGE_TICK);
  chrome.alarms.create(ALARM_BADGE_TICK, { periodInMinutes: 1 });

  await notifyStateChanged();

  try {
    chrome.notifications.create('ff-start-' + now, {
      type: 'basic',
      iconUrl: 'icons/logo/icon128.png',
      title: 'Work session started',
      message: 'Stay focused. I will remind you to take a break soon.',
      priority: 1,
    });
  } catch (e) {
    console.error('Tidy background error:', e);
  }
}

async function pauseSession() {
  const state = await getState();
  if (!state.running || state.paused) return;

  const now = Date.now();
  if (state.sessionStart) {
    state.accumulatedMs += now - state.sessionStart;
  }
  state.sessionStart = null;
  state.paused = true;

  // Freeze the remaining time until the next break so resume can
  // restore it instead of starting a fresh interval.
  if (state.nextBreakAt) {
    state.breakRemainingMs = Math.max(0, state.nextBreakAt - now);
    state.nextBreakAt = null;
  }
  await chrome.alarms.clear(ALARM_BREAK);

  await saveState(state);
  await notifyStateChanged();
}

async function resumeSession() {
  const state = await getState();
  if (!state.running || !state.paused) return;

  state.sessionStart = Date.now();
  state.paused = false;
  await saveState(state);

  const settings = await getSettings();
  const remainingMs = state.breakRemainingMs ?? (settings.breakInterval * 60000);
  await scheduleBreakWithRemaining(remainingMs);

  await notifyStateChanged();
}

async function stopSession() {
  const state = await getState();
  if (!state.running) return { ok: false, reason: 'not running' };

  const now = Date.now();
  let workMs = state.accumulatedMs;
  if (state.sessionStart && !state.paused) {
    workMs += now - state.sessionStart;
  }

  if (workMs > 0) {
    await addWorkMsToToday(workMs, 1);
  }

  await chrome.alarms.clear(ALARM_BREAK);
  await chrome.alarms.clear(ALARM_BREAK_TICK);
  await chrome.alarms.clear(ALARM_BADGE_TICK);

  await saveState(DEFAULT_STATE);
  await notifyStateChanged();

  const mins = Math.round(workMs / 60000);
  if (mins > 0) {
    try {
      chrome.notifications.create('ff-end-' + now, {
        type: 'basic',
        iconUrl: 'icons/logo/icon128.png',
        title: 'Session ended!',
        message: `Nice work — you focused for ${mins} min today. Total saved.`,
        priority: 1,
      });
    } catch (e) {
      console.error('Tidy background error:', e);
    }
  }

  return { ok: true, workMs };
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const state = await getState();

  if (alarm.name === ALARM_BREAK) {
    // While in break mode or paused, repeated triggers are ignored.
    if (state.running && !state.paused && !state.breakMode) {
      await notifyBreak();
    }
  } else if (alarm.name === ALARM_BREAK_TICK) {
    if (state.breakMode) {
      await endBreak(true);
      try {
        chrome.notifications.create('ff-resume-' + Date.now(), {
          type: 'basic',
          iconUrl: 'icons/logo/icon128.png',
          title: 'Break over — back to work!',
          message: "Hope that felt good. Let's keep going.",
          priority: 1,
        });
      } catch (e) {
        console.error('Tidy background error:', e);
      }
      await playSound('resume');
    }
  } else if (alarm.name === ALARM_BADGE_TICK) {
    await updateBadge();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PLAY_SOUND') return; // handled by the offscreen doc
  (async () => {
    try {
      if (msg.type === 'START_SESSION') {
        await startSession();
        sendResponse({ ok: true });
      } else if (msg.type === 'PAUSE_SESSION') {
        await pauseSession();
        sendResponse({ ok: true });
      } else if (msg.type === 'RESUME_SESSION') {
        await resumeSession();
        sendResponse({ ok: true });
      } else if (msg.type === 'STOP_SESSION') {
        sendResponse(await stopSession());
    } else if (msg.type === 'SETTINGS_UPDATED') {
      const state = await getState();
      if (state.running && !state.breakMode) {
        if (state.paused) {
          // A paused session keeps a frozen breakRemainingMs from the old
          // interval; re-derive it from the new settings so resume doesn't
          // restore a stale countdown.
          const settings = await getSettings();
          state.breakRemainingMs = settings.breakInterval * 60 * 1000;
          state.nextBreakAt = null;
          await saveState(state);
        } else {
          await scheduleNextBreak();
        }
      }
      sendResponse({ ok: true });
      } else if (msg.type === 'GET_STATE') {
        sendResponse(await getState());
      } else {
        sendResponse({ ok: false, reason: 'unknown' });
      }
    } catch (e) {
      console.error('Tidy background error:', e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) {
    await saveSettings(DEFAULT_SETTINGS);
  }
  const { state } = await chrome.storage.local.get('state');
  if (!state) {
    await saveState(DEFAULT_STATE);
  }
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  if (state.running) {
    // The browser was closed mid-session; salvage any unsaved time.
    let workMs = state.accumulatedMs;
    if (state.sessionStart && !state.paused) {
      const elapsed = Date.now() - state.sessionStart;
      // Only plausible if the browser was closed for less than a day.
      if (elapsed > 0 && elapsed < 24 * 60 * 60 * 1000) {
        workMs += elapsed;
      }
    }
    if (workMs > 0) {
      await addWorkMsToToday(workMs, 1);
    }
    await saveState(DEFAULT_STATE);
  }
  await chrome.alarms.clearAll();
  await updateBadge();
});
