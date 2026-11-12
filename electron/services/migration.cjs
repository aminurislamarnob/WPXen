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
// A step that must precede the vhost rewrite is one more entry here.
// `prepare(ctx)` gets { store, sites, nginx, phpmyadmin, deps, failed };
// throwing aborts the pass before any vhost is written, and per-Site failures
// go into ctx.failed without stopping it. A prepare that returns
// { retry: true } couldn't do its work yet: the pass carries on, but that
// entry's flag stays unset so the next launch runs it again.
//
// The launch-time vhost rewrite in ipc.cjs defers to this pass while anything
// is pending (pendingSiteUpgrades), so the upgrade launch has one writer and
// one reload; afterwards that rewrite keeps healing drift as before.
const ERROR_PAGES_FLAG = 'migratedToErrorPages';
const WILDCARD_CERTS_FLAG = 'migratedToWildcardCerts';

// #208: re-issue every HTTPS Site's certificate so it covers `*.domain` as
// well (mkcert.certArgs), ahead of the vhost rewrite that adds the wildcard
// server name. Silent: generateCert never prompts, and ensureCA — which can
// show macOS's keychain prompt — is deliberately not called. With no local
// authority on disk mkcert would quietly create a new, untrusted one, so
// nothing is minted then and the re-issue stays pending: those Sites keep
// their old certificate, and a later launch tries again once an authority
// exists (turning HTTPS on goes through ensureCA).
function reissueWildcardCerts({ store, sites, deps, failed }) {
  const httpsSites = sites.filter((s) => s && s.https);
  if (!httpsSites.length) return;
  const mkcert = deps.mkcert || require('./mkcert.cjs');

  if (!mkcert.hasCa()) {
    for (const site of httpsSites) {
      failed.push({
        domain: site.domain,
        error: 'certificate not re-issued: local certificate authority not found',
      });
    }
    return { retry: true };
  }

  let changed = false;
  sites.forEach((site, i) => {
    if (!site || !site.https) return;
    try {
      const { certPath, keyPath } = mkcert.generateCert(site.domain);
      // Same deterministic paths as before in practice; recorded anyway so the
      // vhost written next points at the files just minted.
      if (site.certPath !== certPath || site.keyPath !== keyPath) {
        sites[i] = { ...site, certPath, keyPath };
        changed = true;
      }
    } catch (err) {
      // The old single-name certificate stays on disk and keeps serving.
      failed.push({
        domain: site.domain,
        error: `certificate not re-issued: ${err.message}`,
      });
    }
  });
  if (changed) store.set('sites', sites);
}

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
  { flag: WILDCARD_CERTS_FLAG, prepare: reissueWildcardCerts },
];

const pendingUpgrades = (store) => SITE_UPGRADES.filter((u) => !store.get(u.flag, false));

function pendingSiteUpgrades(store) {
  return pendingUpgrades(store).map((u) => u.flag);
}

async function runSiteUpgrades(store, deps = {}) {
  const pending = pendingUpgrades(store);
  if (!pending.length) return { migrated: false };
  const nginx = deps.nginx || require('./nginx.cjs');
  const phpmyadmin = deps.phpmyadmin || require('./phpmyadmin.cjs');

  const sites = store.get('sites', []);
  const failed = [];
  const ctx = { store, sites, nginx, phpmyadmin, deps, failed };
  const done = [];
  try {
    for (const upgrade of pending) {
      const outcome = await upgrade.prepare(ctx);
      if (!(outcome && outcome.retry)) done.push(upgrade);
    }
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

  for (const upgrade of done) store.set(upgrade.flag, true);
  return { migrated: true, upgraded: done.map((u) => u.flag), failed };
}

// What the Dashboard tells the user about a pass, from its result: the error
// that stopped it and every Site it couldn't bring up to date. Null when
// there is nothing to say.
function siteUpgradeReport(result) {
  const failed = (result && result.failed) || [];
  const error = (result && result.error) || null;
  if (!error && !failed.length) return null;
  return {
    error,
    failed: failed.map(({ domain, error: why }) => ({ domain, error: why })),
  };
}

module.exports = {
  migrateToChildProcs,
  STORE_FLAG,
  migrateToPerSitePhp,
  PER_SITE_PHP_FLAG,
  runSiteUpgrades,
  pendingSiteUpgrades,
  siteUpgradeReport,
  ERROR_PAGES_FLAG,
  WILDCARD_CERTS_FLAG,
};
