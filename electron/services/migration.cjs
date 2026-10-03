'use strict';

// One-time migration from `brew services`-managed daemons to WPXen-supervised
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
  // (silent when the WPXen sudoers file is installed, otherwise one admin
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

// One-time move from the single shared PHP-FPM to one FPM per version on its
// own socket (see php.cjs). Every vhost written before points PHP at
// 127.0.0.1:9000, where nothing of ours listens any more, so all of them are
// rewritten; the FPMs themselves come up through the normal reconcile.
// Collaborators are injectable so this is testable without nginx.
const PER_SITE_PHP_FLAG = 'migratedToPerSitePhp';

async function migrateToPerSitePhp(store, deps = {}) {
  if (store.get(PER_SITE_PHP_FLAG, false)) return { migrated: false };
  const nginx = deps.nginx || require('./nginx.cjs');
  const procman = deps.procman || require('./procman.cjs');
  const phpmyadmin = deps.phpmyadmin || require('./phpmyadmin.cjs');

  // The single-FPM era's slot, in case it's somehow live in this session.
  try {
    await procman.stop('php');
  } catch {}

  const failed = [];
  for (const site of store.get('sites', [])) {
    try {
      nginx.createSiteConfig(site);
    } catch (err) {
      failed.push({ domain: site.domain, error: err.message });
    }
  }
  try {
    if (phpmyadmin.hasVhost()) phpmyadmin.ensureVhost();
  } catch {}
  try {
    nginx.reload();
  } catch {}

  store.set(PER_SITE_PHP_FLAG, true);
  return { migrated: true, failed };
}

module.exports = {
  migrateToChildProcs,
  STORE_FLAG,
  migrateToPerSitePhp,
  PER_SITE_PHP_FLAG,
};
