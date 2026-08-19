# WPXen

**AI-native WordPress development environment.**

A local environment where developers build, test, debug and ship WordPress projects with AI agents as first-class development participants — a native macOS menu bar app that manages nginx, PHP-FPM, MySQL and dnsmasq via Homebrew, so you can spin up WordPress sites in seconds.

Inspired by [Laravel Herd](https://herd.laravel.com).

> **Previously released as WPHerd, then WPDevPilot.** Upgrading from either is
> seamless: the first launch carries your sites, settings and blueprints over
> from the most recent old data directory, archives exported under either name
> still import, and the managed `php.ini`, mu-plugin and sudoers files they left
> behind are replaced in place.

---

## Features

**Local stack**

- **macOS menu bar app** — lives in your tray, out of your way
- **Supervised services** — nginx, PHP-FPM, MySQL and Mailpit run as children of the app (crash-restarted, stopped on quit), so they stay out of macOS "App Background Activity"
- **PHP version switcher** — detects every Homebrew-installed version, switches globally or per site, edits `php.ini` from the app; EOL 8.0/7.4 supported via the `shivammathur/php` tap
- **`.test` domains** — dnsmasq routes `*.test` to `127.0.0.1`, with one-click resolver setup
- **Per-site HTTPS** — mkcert installs a locally-trusted CA and mints browser-trusted certs

**WordPress workflow**

- **Site wizard** — name it, pick a directory and PHP version, configure the DB; WPXen downloads WordPress, creates the database, writes the vhost and sets up the domain
- **WP management** — plugins, themes, admin users and a `wp-config.php` editor, all through WP-CLI
- **One-click admin** — passwordless magic login for local development
- **Clone, export & import** — duplicate a site, or move one as a portable archive (`.wpress` archives from All-in-One WP Migration import too)
- **Blueprints** — snapshot a whole site and spin up new ones from it
- **Change site URL** — rename a domain with a full database search-replace, new vhost and fresh cert
- **Mail catching** — Mailpit captures `mail()` and shows it in an in-app inbox
- **phpMyAdmin** — auto-installed on first use, opens signed in to the right database
- **Share tunnels** — expose a local site publicly through Cloudflare
- **Per-site logs** — view and clear nginx/PHP logs without leaving the app

**Agents**

- **Per-site AI terminals** — run your AI CLI of choice rooted at a site's webroot, with real terminal behaviour (clipboard, search, Cmd+click file links, sessions that survive tab switches)
- **File explorer & editor** — browse and edit the site's files, with git decorations
- **Changes pane** — stage, unstage, discard and diff, per repository
- **In-app browser** — preview a site, wp-admin, phpMyAdmin or the mail inbox in a tab beside the agent working on it

---

## Prerequisites

WPXen manages services installed via [Homebrew](https://brew.sh). Install Homebrew first if you don't have it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

WPXen installs what it needs on first launch — onboarding checks for the core
formulae and offers to `brew install` whatever is missing. To do it yourself:

```bash
brew install nginx php mysql dnsmasq wp-cli
```

Optional extras are installed on demand the first time you use the feature:
`mailpit` (mail catching), `mkcert` (per-site HTTPS), `cloudflared` (share
tunnels) and phpMyAdmin.

To install additional PHP versions:

```bash
brew install php@8.1 php@8.2 php@8.3
```

---

## Getting Started

### Development

```bash
git clone https://github.com/aminurislamarnob/WPXen.git
cd WPXen
npm install
npm run dev
```

This starts Vite (React renderer on `localhost:5173`) and Electron in parallel.

### Production build

```bash
npm run build
```

Outputs a `.dmg` installer to `release/` for both Apple Silicon and Intel.

---

## How it works

```
WPXen (Electron)
├── Main process (Node.js / CJS)
│   ├── procman       → supervises nginx, PHP-FPM, MySQL and Mailpit as child
│   │                   processes (crash restart, graceful stop, orphan cleanup)
│   ├── Services layer
│   │   ├── nginx     → generates vhost configs in {prefix}/etc/nginx/servers/
│   │   ├── PHP-FPM   → runs one php@x.x at a time, plus per-site overrides
│   │   ├── MySQL     → start/stop + database create/drop
│   │   ├── dnsmasq   → configures *.test → 127.0.0.1 (the one service still
│   │   │               managed by `brew services` — it needs root for port 53)
│   │   ├── siteops   → export, import, clone, blueprints, change-URL
│   │   └── agents    → per-site pty sessions for AI CLIs
│   ├── IPC handlers  → bridge between UI and system
│   └── Tray icon     → menu bar quick-access
└── Renderer (React + Vite + Tailwind)
    ├── Dashboard     → live service status + recent sites
    ├── Sites         → site grid, per-site detail, WP management
    ├── Agents        → terminals, file explorer, git changes, in-app browser
    ├── Services      → per-service controls
    ├── PHP           → version switcher + php.ini editing
    ├── Mail          → Mailpit inbox
    └── Settings      → routed, searchable preferences
```

When you add a WordPress site, WPXen:

1. Creates the site directory
2. Runs `wp core download` to fetch WordPress
3. Creates a MySQL database
4. Generates `wp-config.php` with `wp config create`
5. Runs `wp core install` with your chosen admin credentials
6. Writes an nginx server block to `servers/<domain>.conf`
7. Reloads nginx

Your site is immediately available at `http://<name>.test`.

---

## Project structure

```
WPXen/
├── electron/                 # Main process (CommonJS)
│   ├── main.cjs              # App entry, window management, tray
│   ├── preload.cjs           # Secure IPC bridge (contextBridge)
│   ├── ipc.cjs               # All IPC handler registrations
│   ├── store.cjs             # JSON persistence (userData/wpxen-data.json)
│   ├── tray.cjs              # Menu bar icon + context menu
│   └── services/             # One module per concern
│       ├── procman.cjs       # Child-process supervisor
│       ├── brew.cjs          # Homebrew detection + PHP version discovery
│       ├── nginx.cjs         # nginx process + vhost generation
│       ├── php.cjs           # PHP-FPM management + version switching
│       ├── mysql.cjs         # MySQL/MariaDB + database operations
│       ├── dnsmasq.cjs       # dnsmasq config + resolver setup
│       ├── wordpress.cjs     # WordPress install + mu-plugins via WP-CLI
│       ├── siteops.cjs       # Export / import / clone / change-URL engine
│       ├── blueprints.cjs    # Site snapshots
│       ├── agents.cjs        # Per-site pty sessions for AI CLIs
│       ├── browser.cjs       # In-app browser guest policy
│       ├── settings.cjs      # Settings schema + validation
│       └── …                 # mailpit, mkcert, cloudflared, phpmyadmin,
│                             # sudoers, admin, git, logs, setup, rebrand
├── src/                      # Renderer (React)
│   ├── App.jsx               # Routes
│   ├── components/           # Pages + shared primitives (ui.jsx)
│   │   ├── settings/         # Settings shell + one file per section
│   │   └── browser/          # Browser pane, toolbar, error overlay
│   └── lib/                  # Non-React logic
│       ├── terminal/         # xterm glue, session cache, key handling
│       ├── browser/          # webview cache, URL sanitising
│       └── …                 # theme, typography, settings registry
└── test/                     # vitest suites (main-process + pure helpers)
```

## Homebrew paths

WPXen auto-detects your Homebrew prefix:

| Mac                      | Homebrew prefix |
| ------------------------ | --------------- |
| Apple Silicon (M1/M2/M3) | `/opt/homebrew` |
| Intel                    | `/usr/local`    |

nginx vhosts are written to `{prefix}/etc/nginx/servers/`.  
PHP-FPM sockets are expected at `{prefix}/var/run/php/php{version}-fpm.sock`.

---

## DNS setup

Sites are served under `.test` domains (e.g. `mysite.test`). WPXen configures this by:

1. Adding `address=/.test/127.0.0.1` to `{prefix}/etc/dnsmasq.conf`
2. Creating `/etc/resolver/test` with `nameserver 127.0.0.1` (requires your admin password — a macOS dialog will appear)
3. Starting dnsmasq via Homebrew services

Click *_Settings → Setup *.test DNS*_ to run this one-time setup.

---

## In-app browser

The Agents screen can open a browser tab beside the terminal, so you can watch a
page change while an agent edits it.

**Opening a tab.** The globe button in the session tab strip offers the targets
worth reaching for on a site:

| Target         | Goes to                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| **Site**       | the site's own URL                                                       |
| **WP Admin**   | `wp-admin`, upgraded to a one-click magic-login link when that's enabled |
| **phpMyAdmin** | straight to _this site's_ database, already signed in                    |
| **Mail inbox** | the Mailpit inbox                                                        |
| **Blank tab**  | an empty tab with an address bar                                         |

phpMyAdmin installs itself through Homebrew the first time you ask for it, so
that entry can take a moment on first use.

**Where links open.** Settings → General → _Open links in_ decides whether a
site's Open / wp-admin / phpMyAdmin actions — and Cmd+clicked URLs in agent
output — go to your default browser (the default) or to an in-app tab.

**Behaviour.** Tabs keep their page, scroll position and login session when you
switch to a file tab and back. The address bar autocompletes from browsing
history; Settings → General can clear that history, or the browser's cookies and
cache. Cmd+W closes the browser tab (not the window) and Cmd+R reloads the page
(not WPXen). Right-click gives the usual navigation, copy and "open in default
browser" actions, and the toolbar has a DevTools button.

All browser tabs share one session, so signing into a site in one tab carries to
the next.

---

## Tech stack

|               |                                      |
| ------------- | ------------------------------------ |
| Desktop shell | Electron 28                          |
| UI            | React 18 + React Router 6            |
| Styling       | Tailwind CSS 3                       |
| Build         | Vite 5                               |
| Packaging     | electron-builder (DMG, arm64 + x64)  |
| Icons         | lucide-react                         |
| Terminal      | xterm.js + node-pty                  |
| Editor        | CodeMirror 6 (@uiw/react-codemirror) |
| Persistence   | Custom JSON store (no external deps) |
| Tests         | vitest                               |

---

## About the name

> **WPXen — AI-native WordPress development environment.**

- **WP** → WordPress
- **Xen** → a distinctive, technical coined brand, with associations around
  modern computing environments, isolation and orchestration

WPXen is not intended to be a forced acronym. The name itself is the brand,
while the tagline explains its purpose.

### Why a platform name

The product spans the whole local WordPress workflow rather than any single
part of it:

- Complete local WordPress/PHP runtime
- PHP, nginx, MySQL and service management
- WordPress site lifecycle management
- WP-CLI, Mailpit, phpMyAdmin, HTTPS and Xdebug
- Site cloning, blueprints, import/export
- Cloudflare tunnels and local networking
- AI coding agents and embedded agent workflows
- Future agent workspaces, MCP, browser automation and autonomous development

The name has to cover WordPress infrastructure, development workflows and AI
agents working together, and leave room for where the product goes next.

### Brand positioning

The intended product perception is a local, AI-native environment where
developers can build, test, debug and ship WordPress projects with AI agents as
first-class development participants.

WPXen sits between **local WordPress development**, **AI coding agents** and
**agentic workspaces**. Rather than competing directly as another LocalWP or
another Claude Code, the goal is a WordPress-native agentic development
environment.

---

## License

MIT
