'use strict';

// One-time migration from `brew services`-managed daemons to WPDevPilot-supervised
// child processes (see procman.cjs). `brew services stop` both unloads the
// launchd job and deletes its LaunchAgent plist, which is what removes the
// entries from macOS "App Background Activity". dnsmasq is deliberately left
// alone — it stays a root LaunchDaemon (port 53 needs root).

const brew = require('./brew.cjs');
const mysql = require('./mysql.cjs');
const mailpit = require('./mailpit.cjs');

const STORE_FLAG = 'migratedToChildProcs';

async function migrateToChildProcs(store) {
  if (store.get(STORE_FLAG, false)) return;

  // nginx ran as a *root* LaunchDaemon — stopping it needs the sudo path
  // (silent when the WPDevPilot sudoers file is installed, otherwise one admin
  // prompt; acceptable for a one-time migration).
  try {
    brew.stopBrewServiceSudo('nginx');
  } catch {}

  // User-level LaunchAgents: every installed PHP version's formula, the MySQL
  // flavor, and Mailpit. Stopping an already-stopped service is a cheap no-op,
  // so no pre-checks.
  const formulae = new Set();
  for (const v of brew.getInstalledPhpVersions()) {
    const f = brew.phpFormulaForVersion(v);
    if (f) formulae.add(f);
  }
  formulae.add(mysql.getBrewServiceName());
  if (mailpit.isInstalled()) formulae.add('mailpit');

  for (const formula of formulae) {
    try {
      brew.stopBrewService(formula);
    } catch {}
  }

  store.set(STORE_FLAG, true);
}

module.exports = { migrateToChildProcs, STORE_FLAG };
