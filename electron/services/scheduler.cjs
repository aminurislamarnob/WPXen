'use strict';

const mysql = require('./mysql.cjs');
const backups = require('./backups.cjs');

// Scheduled backups. A self-rescheduling setTimeout chain (the
// startStatusPoller pattern — a slow run can never stack overlapping ticks)
// wakes periodically, finds sites whose schedule is due, and backs them up
// sequentially. Runs are skipped entirely while MySQL is down or another run
// is still in flight.

const HOUR_MS = 60 * 60 * 1000;
const INTERVALS = {
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
};

// Whether a site with `schedule` last backed up at `lastBackupAt` (ISO string
// or null) is due at `now`. Unknown/'off' schedules are never due. Pure —
// covered by vitest.
function isBackupDue(schedule, lastBackupAt, now = Date.now()) {
  const interval = INTERVALS[schedule];
  if (!interval) return false;
  if (!lastBackupAt) return true;
  const last = new Date(lastBackupAt).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= interval;
}

// Resolves a site's effective schedule: per-site override, else the global
// default. Pure — covered by vitest.
function effectiveSchedule(site, defaultSchedule) {
  return site.backupSchedule || defaultSchedule || 'off';
}

let running = false;

// One scheduler pass. Exposed for tests and for the "run now" path; the
// in-flight flag guarantees passes never overlap.
async function runDueBackups(store, { onEvent } = {}) {
  if (running) return { skipped: 'in-flight' };
  running = true;
  const emit = onEvent || (() => {});
  try {
    if (!(await mysql.isRunningAsync())) return { skipped: 'mysql-down' };
    const defaultSchedule = store.get('settings.backups.defaultSchedule', 'off');
    let completed = 0;
    for (const site of store.get('sites', [])) {
      const schedule = effectiveSchedule(site, defaultSchedule);
      if (!isBackupDue(schedule, site.lastBackupAt)) continue;
      try {
        const meta = await backups.createBackup(store, site, { trigger: 'scheduled' });
        backups.applyRetention(store, site.id);
        completed += 1;
        emit({ type: 'backup-complete', site, backup: meta });
      } catch (err) {
        emit({ type: 'backup-failed', site, error: err.message });
      }
    }
    return { completed };
  } finally {
    running = false;
  }
}

// Starts the hourly wake-up chain. The first pass runs a couple of minutes
// after launch so app startup (service auto-start, migrations) settles first.
function startBackupScheduler(store, { onEvent, firstDelayMs = 2 * 60 * 1000 } = {}) {
  async function tick() {
    try {
      await runDueBackups(store, { onEvent });
    } catch {}
    setTimeout(tick, HOUR_MS);
  }
  setTimeout(tick, firstDelayMs);
}

module.exports = {
  isBackupDue,
  effectiveSchedule,
  runDueBackups,
  startBackupScheduler,
};
