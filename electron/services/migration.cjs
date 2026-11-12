'use strict';

// One-time migration from `brew services`-managed daemons to WPXen-supervised
// child processes (see procman.cjs). `brew services stop` both unloads the
// launchd job and deletes its LaunchAgent plist, which is what removes the
// entries from macOS "App Background Activity". dnsmasq is not handled here:
// its root LaunchDaemon goes when the user accepts the DNS migration notice
// (dnsmasq.migrateToRootless), which needs an admin prompt of its own.

const brew = require('./brew.cjs');
const mysql = require('./mysql.cjs');
const mailpit = require('./mailpit.cjs');

const STORE_FLAG = 'migratedToChildProcs';

async function migrateToChildProcs(store) {
  if (store.get(STORE_FLAG, false)) return;

  // nginx ran as a *root* LaunchDaemon — stopping it takes one admin prompt,
  // acceptable for a one-time migration.
  try {
    brew.stopBrewServiceAdmin('nginx');
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

// One-time upgrades of every Site's vhost that ship with an app update. Each
// has its own store flag, so it runs once even when it ships in a later
// release than the others. All pending ones run as ONE pass: their `prepare`
// steps in order, then one regeneration of every vhost (phpMyAdmin's
// included), one `nginx -t`, one reload — and only then are their flags set.
//
// A step that must precede the vhost rewrite is one more entry here: #208's
// wildcard-certificate re-issue (its own flag; re-issue only for HTTPS Sites,
// collecting per-Site failures into ctx.failed) goes after the error pages.
// `prepare(ctx)` gets { sites, nginx, phpmyadmin, deps, failed }; throwing
// aborts the pass before any vhost is written.
//
// The launch-time vhost rewrite in ipc.cjs defers to this pass while anything
// is pending (pendingSiteUpgrades), so the upgrade launch has one writer and
// one reload; afterwards that rewrite keeps healing drift as before.
const ERROR_PAGES_FLAG = 'migratedToErrorPages';

const SITE_UPGRADES = [
  {
    // #207: the shared snippet and the 502 page (errorPages.cjs). Every
    // regenerated vhost includes the snippet, and an include of a missing
    // file fails `nginx -t`, so they're on disk before any vhost is written.
    flag: ERROR_PAGES_FLAG,
    prepare: ({ nginx }) => {
      if (!nginx.ensureErrorPages()) throw new Error('nginx config folder not found');
    },
  },
];

function pendingSiteUpgrades(store) {
  return SITE_UPGRADES.filter((u) => !store.get(u.flag, false)).map((u) => u.flag);
}

async function runSiteUpgrades(store, deps = {}) {
  const pending = SITE_UPGRADES.filter((u) => !store.get(u.flag, false));
  if (!pending.length) return { migrated: false };
  const nginx = deps.nginx || require('./nginx.cjs');
  const phpmyadmin = deps.phpmyadmin || require('./phpmyadmin.cjs');

  const sites = store.get('sites', []);
  const failed = [];
  const ctx = { sites, nginx, phpmyadmin, deps, failed };
  try {
    for (const upgrade of pending) await upgrade.prepare(ctx);
  } catch (err) {
    return { migrated: false, error: err.message, failed };
  }

  let written = 0;
  for (const site of sites) {
    try {
      nginx.createSiteConfig(site);
      written++;
    } catch (err) {
      failed.push({ domain: site.domain, error: err.message });
    }
  }
  // Written without its own reload (ensureVhost reloads), so the pass reloads
  // nginx exactly once.
  try {
    if (phpmyadmin.hasVhost()) {
      phpmyadmin.writeVhost();
      written++;
    }
  } catch (err) {
    failed.push({ domain: phpmyadmin.DOMAIN, error: err.message });
  }

  if (written) {
    // nginx ignores a SIGHUP whose config it refuses and keeps serving the old
    // one, silently — so test first, report the error, and leave the flags
    // unset so the next launch retries.
    const { valid, error } = nginx.validateConfig();
    if (!valid) {
      return { migrated: false, error: `nginx config test failed: ${error}`, failed };
    }
    try {
      nginx.reload();
    } catch {}
  }

  for (const upgrade of pending) store.set(upgrade.flag, true);
  return { migrated: true, upgraded: pending.map((u) => u.flag), failed };
}

module.exports = {
  migrateToChildProcs,
  STORE_FLAG,
  migrateToPerSitePhp,
  PER_SITE_PHP_FLAG,
  runSiteUpgrades,
  pendingSiteUpgrades,
  ERROR_PAGES_FLAG,
};
