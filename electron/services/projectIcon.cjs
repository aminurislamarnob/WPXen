'use strict';

// The icon a project (a Site) shows in the Agents sidebar, after Orca's
// repo-icon detection (src/main/repo-icon-*.ts in stablyai/orca):
//
//   0. A custom icon the user chose (Change Project Icon): an emoji, or an
//      uploaded PNG/WebP kept at userData/project-icons/<siteId>.<ext>. The
//      Site record holds only `icon: { type: 'emoji', emoji }` or
//      `{ type: 'image', file }`.
//   1. The Site's own WordPress Site Icon, when one is set.
//   2. When the Site's folder is itself a GitHub repo, Orca's order:
//        a conventional icon file in the repo (favicon.png, public/logo.png…),
//        an icon declared in index.html / a root route,
//        the favicon of package.json's `homepage`,
//        the GitHub owner's avatar (a fork reads as its parent project,
//        unless it was renamed).
//   3. Otherwise the WordPress logo — `{ type: 'wordpress' }`, drawn by the
//      renderer.
//
// Icons from disk become data URIs, so the renderer never needs file access
// and the CSP only has to allow GitHub's and Google's favicon hosts.
//
// WP-CLI, git and the filesystem are reached through `deps`; Electron is never
// required.

const fs = require('fs');
const path = require('path');

const MAX_ICON_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const CACHE_MS = 10 * 60 * 1000;
// A failed lookup (MySQL not running yet, WP-CLI missing) is retried sooner.
const RETRY_MS = 30 * 1000;

// Orca's conventional icon locations, PNG and WebP only.
const ICON_FILE_STEMS = [
  'favicon',
  'public/favicon',
  'app/favicon',
  'app/icon',
  'src/favicon',
  'src/app/icon',
  'assets/favicon',
  'assets/icon',
  'static/favicon',
  'logo',
  'public/logo',
  'public/icon',
  'src-tauri/icons/icon',
  'app-icon',
  'icon',
];
const ICON_FILE_CANDIDATES = ICON_FILE_STEMS.flatMap((stem) => [
  `${stem}.png`,
  `${stem}.webp`,
]);

const ICON_SOURCE_FILES = [
  'index.html',
  'public/index.html',
  'app/routes/__root.tsx',
  'src/routes/__root.tsx',
  'app/root.tsx',
  'src/root.tsx',
  'src/index.html',
];

// Hosts whose favicon says nothing about the project.
const HOMEPAGE_HOSTS_TO_SKIP = new Set([
  'github.com',
  'www.github.com',
  'gitlab.com',
  'www.gitlab.com',
  'bitbucket.org',
  'www.bitbucket.org',
]);

// The Site Icon's file on disk: the 64px rendition when WordPress made one,
// else the original. Printed by `wp eval`; nothing when no icon is set.
const SITE_ICON_PHP = [
  '$id = (int) get_option("site_icon");',
  'if (!$id) { return; }',
  '$file = get_attached_file($id);',
  '$size = image_get_intermediate_size($id, array(64, 64));',
  'if ($size && !empty($size["path"])) {',
  '  $uploads = wp_upload_dir();',
  '  $file = trailingslashit($uploads["basedir"]) . $size["path"];',
  '}',
  'echo $file;',
].join(' ');

const deps = {
  runWp: (args, cwd) => require('./wordpress.cjs').wpAsync(args, cwd, { timeout: 20000 }),
  remotes: async (repoRoot) => {
    const out = await new Promise((resolve) => {
      require('child_process').execFile(
        'git',
        ['-C', repoRoot, 'remote', '-v'],
        { timeout: 8000 },
        (err, stdout) => resolve(err ? '' : String(stdout))
      );
    });
    // → [{ name, url }]
    return Object.entries(require('./git.cjs').parseRemotes(out)).map(([name, url]) => ({
      name,
      url,
    }));
  },
  now: () => Date.now(),
};

function __setDeps(next) {
  Object.assign(deps, next);
  cache.clear();
}

// ── Images ───────────────────────────────────────────────────────────────────

function imageMime(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x00000100) return 'image/x-icon';
  return null;
}

// A bounded image file → data URI, or null. `allowed` narrows the formats
// (Orca accepts only PNG and WebP from a repo).
function imageDataUri(file, allowed = null) {
  try {
    const info = fs.statSync(file);
    if (!info.isFile() || info.size > MAX_ICON_BYTES) return null;
    const buf = fs.readFileSync(file);
    const mime = imageMime(buf);
    if (!mime || (allowed && !allowed.includes(mime))) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// ── 1. WordPress Site Icon ───────────────────────────────────────────────────

// → { icon } | { icon: null } (no Site Icon) | { error } (couldn't ask).
async function detectSiteIcon(sitePath) {
  let file;
  try {
    file = String(await deps.runWp(['eval', SITE_ICON_PHP], sitePath)).trim();
  } catch (err) {
    return { error: err };
  }
  if (!file) return { icon: null };
  const src = imageDataUri(file);
  return { icon: src ? { type: 'image', src, source: 'site-icon' } : null };
}

// ── 2. A GitHub repo, the way Orca reads one ─────────────────────────────────

// The first <link rel="…icon…" href="…"> in a page or root route.
function extractIconHref(source) {
  const tags = String(source).match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/\brel\s*=\s*["'][^"']*\bicon\b[^"']*["']/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href && !/^(?:[a-z]+:)?\/\//i.test(href) && !href.startsWith('data:'))
      return href;
  }
  return null;
}

// Where a declared href may live: relative to the source file, the repo root,
// or a framework's public/ folder (Vite and Next serve `/x.png` from it).
function iconHrefCandidates(href, sourceFile) {
  const clean = href.split(/[?#]/)[0];
  const rel = clean.replace(/^\/+/, '');
  const out = [];
  if (clean.startsWith('/')) out.push(rel, `public/${rel}`);
  else
    out.push(
      path.posix.join(path.posix.dirname(sourceFile), clean),
      rel,
      `public/${rel}`
    );
  // Never outside the repo: normalised first, so `public/../../x` is caught.
  return [...new Set(out.map((p) => path.posix.normalize(p)))].filter(
    (p) => p && p !== '.' && !p.startsWith('..') && !path.isAbsolute(p)
  );
}

function repoFileIcon(repoRoot) {
  const formats = ['image/png', 'image/webp'];
  for (const rel of ICON_FILE_CANDIDATES) {
    const src = imageDataUri(path.join(repoRoot, rel), formats);
    if (src) return { type: 'image', src, source: 'file', label: rel };
  }
  for (const sourceFile of ICON_SOURCE_FILES) {
    let source;
    try {
      const file = path.join(repoRoot, sourceFile);
      const info = fs.statSync(file);
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) continue;
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const href = extractIconHref(source);
    if (!href) continue;
    for (const rel of iconHrefCandidates(href, sourceFile)) {
      const src = imageDataUri(path.join(repoRoot, rel), formats);
      if (src) return { type: 'image', src, source: 'file', label: rel };
    }
  }
  return null;
}

function faviconUrlFromWebsite(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    if (HOMEPAGE_HOSTS_TO_SKIP.has(url.hostname.toLowerCase())) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=64`;
  } catch {
    return null;
  }
}

function homepageIcon(repoRoot) {
  try {
    const file = path.join(repoRoot, 'package.json');
    const info = fs.statSync(file);
    if (!info.isFile() || info.size > 128 * 1024) return null;
    const src = faviconUrlFromWebsite(JSON.parse(fs.readFileSync(file, 'utf8')).homepage);
    return src
      ? { type: 'image', src, source: 'favicon', label: 'Website favicon' }
      : null;
  } catch {
    return null;
  }
}

// Orca's rule: a fork that kept its name is a personal copy and reads as the
// parent project (upstream); a renamed fork is its own project (origin).
function githubAvatarSlug(origin, upstream) {
  const renamedFork =
    origin && upstream && origin.name.toLowerCase() !== upstream.name.toLowerCase();
  return renamedFork ? origin : upstream || origin || null;
}

const OWNER = /^[A-Za-z0-9-]{1,39}$/;

async function githubAvatarIcon(repoRoot) {
  const { parseGithubRemote } = require('./git.cjs');
  const remotes = await deps.remotes(repoRoot);
  const github = (name) => {
    const r = remotes.find((x) => x.name === name);
    return r ? parseGithubRemote(r.url) : null;
  };
  const anyGithub = remotes.map((r) => parseGithubRemote(r.url)).find(Boolean) || null;
  const slug = githubAvatarSlug(github('origin') || anyGithub, github('upstream'));
  if (!slug || !OWNER.test(slug.owner)) return null;
  return {
    type: 'image',
    src: `https://github.com/${encodeURIComponent(slug.owner)}.png?size=64`,
    source: 'github',
    label: `${slug.owner}/${slug.name}`,
  };
}

// The repo has to be the Site's own folder — a theme or plugin repo nested
// inside it is that component's, not the project's.
function isRepoRoot(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

async function detectRepoIcon(repoRoot) {
  if (!isRepoRoot(repoRoot)) return null;
  const remotes = await deps.remotes(repoRoot);
  const { parseGithubRemote } = require('./git.cjs');
  if (!remotes.some((r) => parseGithubRemote(r.url))) return null;
  return (
    repoFileIcon(repoRoot) || homepageIcon(repoRoot) || (await githubAvatarIcon(repoRoot))
  );
}

// ── The project's icon ───────────────────────────────────────────────────────

const WORDPRESS = { type: 'wordpress' };
const cache = new Map(); // site.id → { at, ttl, key, icon }

// ── 0. A custom icon ─────────────────────────────────────────────────────────

const MAX_EMOJI_LENGTH = 16;

// What a Site record may carry as its custom icon; anything else is ignored.
function sanitizeCustomIcon(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'emoji') {
    const emoji = String(value.emoji || '').trim();
    // An emoji, not text: no letters or digits from the ASCII range.
    if (!emoji || emoji.length > MAX_EMOJI_LENGTH || /[A-Za-z0-9<>]/.test(emoji))
      return null;
    return { type: 'emoji', emoji };
  }
  if (value.type === 'image') {
    const file = String(value.file || '');
    return /^[\w.-]+\.(png|webp)$/.test(file) ? { type: 'image', file } : null;
  }
  return null;
}

// An uploaded image → the file it's kept as. `base64` is the file's bytes;
// only a real PNG or WebP (by signature) under the size cap is accepted.
// → { file } or { error }.
function writeIconImage(dir, siteId, base64) {
  if (!/^[\w-]+$/.test(String(siteId || ''))) return { error: 'Invalid site' };
  let buf;
  try {
    buf = Buffer.from(String(base64 || ''), 'base64');
  } catch {
    return { error: 'That file couldn’t be read.' };
  }
  if (!buf.length) return { error: 'That file is empty.' };
  if (buf.length > MAX_ICON_BYTES) return { error: 'Images must be 256 KB or smaller.' };
  const mime = imageMime(buf);
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : null;
  if (!ext) return { error: 'Use a PNG or WebP image.' };
  fs.mkdirSync(dir, { recursive: true });
  removeIconImages(dir, siteId);
  const file = `${siteId}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return { file };
}

// Every image kept for a Site (either extension) — on reset, on a new
// upload, and when the Site is deleted.
function removeIconImages(dir, siteId) {
  if (!/^[\w-]+$/.test(String(siteId || ''))) return;
  for (const ext of ['png', 'webp']) {
    try {
      fs.rmSync(path.join(dir, `${siteId}.${ext}`), { force: true });
    } catch {
      // nothing to remove
    }
  }
}

function customIcon(site, iconDir) {
  const icon = sanitizeCustomIcon(site.icon);
  if (!icon) return null;
  if (icon.type === 'emoji') return { ...icon, source: 'custom' };
  if (!iconDir) return null;
  const src = imageDataUri(path.join(iconDir, icon.file), ['image/png', 'image/webp']);
  return src ? { type: 'image', src, source: 'custom' } : null;
}

// Drop a Site's cached icon, so the next ask detects (or reads) it afresh.
function invalidate(siteId) {
  cache.delete(siteId);
}

async function projectIcon(site, { force = false, iconDir = null } = {}) {
  if (!site?.id || !site?.path) return WORDPRESS;
  // A custom icon is the user's choice and costs no lookup: never cached.
  const custom = customIcon(site, iconDir);
  if (custom) return custom;
  const key = site.path;
  const hit = cache.get(site.id);
  if (!force && hit && hit.key === key && deps.now() - hit.at < hit.ttl) return hit.icon;

  const wp = await detectSiteIcon(site.path);
  let icon = wp.icon || (await detectRepoIcon(site.path)) || WORDPRESS;
  // Couldn't ask WordPress (MySQL down?) and nothing else answered: show the
  // logo now, ask again soon.
  const ttl = wp.error && icon === WORDPRESS ? RETRY_MS : CACHE_MS;
  if (!icon) icon = WORDPRESS;
  cache.set(site.id, { at: deps.now(), ttl, key, icon });
  return icon;
}

module.exports = {
  ICON_FILE_CANDIDATES,
  imageMime,
  extractIconHref,
  iconHrefCandidates,
  faviconUrlFromWebsite,
  githubAvatarSlug,
  detectRepoIcon,
  sanitizeCustomIcon,
  writeIconImage,
  removeIconImages,
  invalidate,
  projectIcon,
  __setDeps,
};
