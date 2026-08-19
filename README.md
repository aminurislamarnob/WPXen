# WPXen

**AI-native WordPress development environment.**

A local environment where developers build, test, debug and ship WordPress projects with AI agents as first-class development participants — a native macOS menu bar app that manages nginx, PHP-FPM, MySQL and dnsmasq via Homebrew, so you can spin up WordPress sites in seconds.

Inspired by [Laravel Herd](https://herd.laravel.com).

> **Previously released as WPHerd, then WPDevPilot** (see [Naming decision
> history](#naming-decision-history)). Upgrading from either is
> seamless: the first launch carries your sites, settings and blueprints over
> from the most recent old data directory, archives exported under either name
> still import, and the managed `php.ini`, mu-plugin and sudoers files they left
> behind are replaced in place.

---

## Features

- **macOS menu bar app** — lives in your tray, out of your way
- **One-click service management** — start/stop nginx, PHP-FPM, MySQL, dnsmasq individually or all at once
- **WordPress site wizard** — 3-step setup: name your site, pick a directory and PHP version, configure the DB — WPXen handles the rest (downloads WordPress, creates the database, configures nginx, sets up your `.test` domain)
- **Per-site quick actions** — open in browser, open wp-admin, reveal in Finder, open in Terminal
- **In-app browser** — preview a site, wp-admin or phpMyAdmin in a tab beside the agent working on it
- **PHP version switcher** — detects all Homebrew-installed PHP versions and switches between them
- **`.test` domain support** — dnsmasq routes `*.test` to `127.0.0.1` automatically
- **Settings panel** — configure sites directory, start at login, one-click dnsmasq setup

---

## Screenshots

| Dashboard                        | Sites                    |
| -------------------------------- | ------------------------ |
| ![Dashboard](docs/dashboard.png) | ![Sites](docs/sites.png) |

| Add Site                       | Services                       |
| ------------------------------ | ------------------------------ |
| ![Add Site](docs/add-site.png) | ![Services](docs/services.png) |

| PHP Versions         | Settings                       |
| -------------------- | ------------------------------ |
| ![PHP](docs/php.png) | ![Settings](docs/settings.png) |

---

## Prerequisites

WPXen manages services installed via [Homebrew](https://brew.sh). Install Homebrew first if you don't have it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then install the required services:

```bash
brew install nginx php mysql dnsmasq wp-cli
```

To install additional PHP versions:

```bash
brew install php@8.1 php@8.2 php@8.3
```

---

## Getting Started

### Development

```bash
git clone https://github.com/aminurislamarnob/wpxen.git
cd wpxen
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
│   ├── Services layer — wraps Homebrew CLI to manage processes
│   │   ├── nginx     → generates vhost configs in /opt/homebrew/etc/nginx/servers/
│   │   ├── PHP-FPM   → starts/stops php@x.x via brew services
│   │   ├── MySQL     → start/stop + database create/drop
│   │   └── dnsmasq   → configures *.test → 127.0.0.1 resolver
│   ├── IPC handlers  → bridge between UI and system
│   └── Tray icon     → menu bar quick-access
└── Renderer (React + Vite + Tailwind)
    ├── Dashboard     → live service status + recent sites
    ├── Sites         → site grid + add/remove wizard
    ├── Services      → per-service controls
    ├── PHP           → version switcher
    └── Settings      → preferences + dependency checker
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
wpxen/
├── electron/
│   ├── main.cjs          # App entry, window management, tray
│   ├── preload.cjs       # Secure IPC bridge (contextBridge)
│   ├── ipc.cjs           # All IPC handler registrations
│   ├── store.cjs         # JSON persistence (userData/wpxen-data.json)
│   ├── tray.cjs          # Menu bar icon + context menu
│   └── services/
│       ├── brew.cjs      # Homebrew detection + PHP version discovery
│       ├── nginx.cjs     # nginx process + vhost config generation
│       ├── php.cjs       # PHP-FPM management + version switching
│       ├── mysql.cjs     # MySQL/MariaDB management + DB operations
│       ├── dnsmasq.cjs   # dnsmasq config + /etc/resolver/test
│       └── wordpress.cjs # WordPress install via WP-CLI
└── src/
    ├── App.jsx
    └── components/
        ├── Dashboard.jsx
        ├── Sites.jsx
        ├── SiteCard.jsx
        ├── AddSiteModal.jsx
        ├── Services.jsx
        ├── PHPVersions.jsx
        ├── Settings.jsx
        └── StatusBadge.jsx
```

---

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
| Persistence   | Custom JSON store (no external deps) |

---

## Naming decision history

**WPDevPilot → WPXen.** Final name: **WPXen**. Tagline: _AI-native WordPress
development environment._

### Why WPXen was selected

WPDevPilot originally represented the product as an AI assistant — a "pilot" —
for WordPress development. As the product evolved, its scope expanded well
beyond an AI coding assistant:

- Complete local WordPress/PHP runtime
- PHP, nginx, MySQL and service management
- WordPress site lifecycle management
- WP-CLI, Mailpit, phpMyAdmin, HTTPS and Xdebug
- Site cloning, blueprints, import/export
- Cloudflare tunnels and local networking
- AI coding agents and embedded agent workflows
- Future agent workspaces, MCP, browser automation and autonomous development

"DevPilot" therefore became too narrow: it describes mainly the AI
developer/assistant aspect. WPXen better represents the product as a platform
and environment where WordPress infrastructure, development workflows and AI
agents work together.

### Meaning of WPXen

- **WP** → WordPress
- **Xen** → a distinctive, technical coined brand, with associations around
  modern computing environments, isolation and orchestration

WPXen is not intended to be a forced acronym. The name itself is the brand,
while the tagline explains its purpose.

### Brand positioning

> **WPXen — AI-native WordPress development environment.**

The intended product perception is a local, AI-native environment where
developers can build, test, debug and ship WordPress projects with AI agents as
first-class development participants.

### Strategic direction

WPXen is positioned between **local WordPress development**, **AI coding
agents** and **agentic workspaces**. Rather than competing directly as another
LocalWP or another Claude Code, the goal is a WordPress-native agentic
development environment.

### Decision

Rebrand from WPDevPilot to WPXen, because WPXen provides broader brand
flexibility for the product's long-term evolution.

---

## License

MIT
