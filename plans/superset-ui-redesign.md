# WPHerd UI Redesign — Adopt the Superset Design System

**Status:** implemented (Phases 0–6, pending visual QA) · **Author:** design analysis of `reference/superset-main` (Superset desktop, `apps/desktop`)

> **Implementation notes / deviations from the plan as written:**
>
> - `wp.*` Tailwind colors and `boxShadow.card*` were kept as **aliases onto the
>   new tokens** through Phase 1 rather than deleted immediately, so the app
>   stayed usable between phases. `wp.*` still exists as a deprecated shim;
>   `shadow-card*` is gone (zero call sites remain).
> - All component classes in `index.css` were moved into `@layer components` so
>   call-site utilities reliably beat them (`.panel` setting `rounded-lg` would
>   otherwise silently override a call-site `rounded-*`).
> - `.card-running` (§8, marked optional) is **defined but not applied** —
>   `SiteCard` has no site-level run state, only a share-tunnel state, and
>   tinting the card green for a live tunnel would misrepresent it.
> - `Kbd` gained a `tone` prop so one component covers both the tooltip
>   (inverted) and standalone (`bg-muted`) recipes.
> - Folder glyph colors in `FileExplorer`/`fileIcons` were left colored — a
>   file-type affordance, consistent with keeping the colored icon tiles.
> - `dark:` variant count went 249 → **1** (`dark:bg-input/60` on the active
>   segmented tab), well under the <30 target.

WPHerd currently mimics macOS System Settings + Liquid Glass (transparent window over
NSVisualEffectView, capsule buttons, frosted translucent cards, colored icon tiles,
blue accent). This plan replaces that aesthetic with **Superset's** design language:
an opaque, warm near-black "ember" dark theme + clean neutral light theme, flat
bordered cards, shadcn-style semantic tokens, segmented tabs, token-driven
terminal/editor themes, and JetBrains-Mono-first monospace. Two deliberate
WPHerd carve-outs from Superset's look: **blue stays the brand/highlight color**
(not ember orange) and **the sidebar keeps its colored icon tiles** (§2.3–2.4).

Read this whole document before writing code. Phases are ordered so the app stays
usable after every phase. **Do not touch `electron/services/*` logic, `ipc.cjs`
handlers, or `preload.cjs`** — this is a renderer + window-chrome redesign only
(the only main-process change is the BrowserWindow options in Phase 0).

---

## 1. Superset design system — analysis findings

All paths below are inside `reference/superset-main/`.

### 1.1 Token architecture

Source: `apps/desktop/src/renderer/globals.css`, `apps/desktop/src/shared/themes/built-in/*.ts`

- shadcn/ui-style **semantic CSS variables**: `--background`, `--foreground`,
  `--card`, `--popover`, `--primary`, `--secondary`, `--muted`,
  `--muted-foreground`, `--accent`, `--tertiary`, `--tertiary-active`,
  `--destructive`, `--border`, `--input`, `--ring`, `--sidebar*` (8 vars),
  `--chart-1..5`, `--highlight` (brand orange), `--highlight-match/active`
  (search tints), `--radius: 0.625rem`.
- Dark is the **default** (`:root`), light is the override (`:root.light`).
- Radius scale: `sm = radius−4px (6px)`, `md = radius−2px (8px)`, `lg = 10px`,
  `xl = radius+4px (14px)`.

### 1.2 The "ember" dark palette (`built-in/ember.ts`)

Warm, slightly reddish neutrals — this is the signature look:

| Token | Value | Role |
|---|---|---|
| background | `#151110` | window/app background |
| foreground | `#eae8e6` | primary text (warm off-white) |
| card / popover | `#201e1c` | raised surfaces |
| secondary / muted / accent / border / input | `#2a2827` | fills, borders |
| muted-foreground | `#a8a5a3` | secondary text |
| tertiary | `#1a1716` | panel/toolbar bg (also sidebar) |
| tertiary-active | `#252220` | active toolbar / sidebar hover |
| primary | `#eae8e6` (fg on it: `#151110`) | **monochrome** primary buttons |
| destructive | `#cc4444` (fg `#ffcccc`) | danger |
| ring | `#3a3837` | focus rings |
| highlight | `#e07850` | brand ember orange (cursor, active accents, sidebar-primary) |
| chart-1..5 | `#e07850 #50a878 #d4a84b #7b68ee #dc6b6b` | data colors |

Light theme (`built-in/light.ts`): pure neutral oklch — `background oklch(1 0 0)`,
`foreground oklch(0.145 0 0)`, `card/secondary/muted oklch(0.97 0 0)`,
`muted-foreground oklch(0.556 0 0)`, `border/input oklch(0.922 0 0)`,
`ring oklch(0.708 0 0)`, `sidebar oklch(0.985 0 0)`, tertiary gets a faint warm
hue `oklch(0.95 0.003 40)`, highlight `oklch(0.646 0.222 41.116)` (same orange family).

Key insight: **primary actions are monochrome** (near-white button on dark,
near-black on light); the ember orange is an *accent*, used for the terminal
cursor, selection/search tints, brand moments — not for every button.

### 1.3 Surfaces & cards

- Window is **opaque** — `backgroundColor: '#252525'/'#ffffff'`,
  `titleBarStyle: "hidden"`, `trafficLightPosition: {x:16, y:16}`
  (`apps/desktop/src/main/windows/main.ts`). **No vibrancy, no glass.**
- Card (`packages/ui/src/components/ui/card.tsx`):
  `bg-card border rounded-xl shadow-sm` — flat, hairline-bordered, subtle shadow.
- Sidebar card (`sidebar-card.tsx`): `rounded-lg border border-border bg-card p-3`,
  title `text-sm font-semibold`, description `text-xs text-muted-foreground`.
- Pane chrome (`mosaic-theme.css`): `0.5px solid var(--color-border)` borders,
  28px toolbars in `--color-tertiary` (focused → `--color-secondary`), toolbar
  titles `11px font-medium` in muted-foreground → foreground when focused,
  controls hidden until hover (`opacity 0 → 1, transition .15s`).
- Run-state tinting via `color-mix`: running `#10b981`, stopped-by-user
  `#f59e0b`, exited `#ef4444`, mixed 25% into borders / 12% into toolbar bg.

### 1.4 Components (`packages/ui/src/components/ui/`)

- **Button** (`button.tsx`): `rounded-md text-sm font-medium gap-2 transition-all`,
  sizes `h-9 px-4` / sm `h-8 px-3` / xs `h-7 px-2.5 text-xs` / `icon` squares;
  variants: `default` (bg-primary), `destructive`, `outline`
  (`border bg-background shadow-xs hover:bg-accent`, dark: `bg-input/30`),
  `secondary`, `ghost` (`hover:bg-accent`), `link`. Focus:
  `focus-visible:ring-[3px] ring-ring/50`. Icons default `size-4` (16px).
- **Input** (`input.tsx`): `h-9 rounded-md border bg-transparent px-3 shadow-xs`,
  dark `bg-input/30`, focus `ring-[3px] ring-ring/50 border-ring`.
- **Badge**: `rounded-full border px-2 py-0.5 text-xs font-medium`; special
  `box` variant: `rounded-none uppercase text-[10px] tracking-wider px-1.5`.
- **Tabs** (segmented control): list `bg-muted rounded-lg p-[3px] h-9`, trigger
  `rounded-[7px] px-2 py-1 text-sm font-medium`, active
  `bg-background shadow-sm` (dark: `bg-input/30 border-input`).
- **Tooltip**: `bg-foreground text-background rounded-md px-3 py-1.5 text-xs`
  + 45°-rotated arrow; `<Kbd>` inside tooltips at `bg-background/20`.
- **Kbd**: `bg-muted text-muted-foreground h-5 min-w-5 rounded-sm px-1 text-xs font-medium`.
- **Dialog**: overlay `bg-black/50`; content
  `bg-background rounded-lg border p-6 shadow-lg max-w-lg`, zoom/fade animations.
- **Dropdown/menus**: `bg-popover rounded-lg border p-1 shadow-md`; items
  `rounded-sm px-2 py-1.5 text-sm`, destructive items `text-destructive`.
- **Switch**: track `w-8 h-[1.15rem] rounded-full`, checked `bg-primary`
  (monochrome!), unchecked `bg-input`; thumb `size-4 bg-background`.
- **Scrollbars** (`globals.css`): 12px, thumb `rgb(63 63 70 / .5)` with
  `border: 3px solid transparent; background-clip: padding-box; border-radius: 6px`,
  hover `.7`; `.scrollbar-thin` variant 8px/2px for compact areas.

### 1.5 Typography

- **UI font:** system sans (Tailwind default stack) — no bundled UI font.
- **Terminal font** (`renderer/lib/terminal/appearance/index.ts`):
  `"JetBrains Mono", "JetBrainsMono Nerd Font", "MesloLGM Nerd Font", …,
  "Menlo", "Monaco", "Courier New", monospace` at **14px**, with a
  monospace-validation guard.
- **Code editor font** (`CodeEditor/constants.ts`):
  `ui-monospace, Menlo, Consolas, Liberation Mono, monospace` at **13px**,
  line-height `round(fontSize × 1.5)`.
- SF Mono is loaded from the macOS system path via a custom
  `superset-font://` protocol (`renderer/styles/bundled-fonts.css`) — optional
  nicety, not required for the look.
- Scale in practice: body/controls `text-sm` (13–14px), toolbar titles 11px
  `font-medium` + `letter-spacing: 0.01em`, section titles `text-sm font-semibold`,
  metadata `text-xs text-muted-foreground`.

### 1.6 Terminal (xterm) — `Terminal/config.ts` + `lib/terminal/appearance/`

- Theme comes **from the app theme**, not hardcoded: `theme.terminal` block has
  bg/fg/cursor/selection + full 16-color ANSI. Ember ANSI: red `#dc6b6b`,
  green `#7ec699`, yellow `#e5c07b`, blue `#61afef`, magenta `#c678dd`,
  cyan `#56b6c2`, brightBlack `#5c5856`, bright variants lighter.
- Terminal background **equals the app background** (`#151110`) — the terminal
  blends into the page, no separate "dark box".
- Cursor: **ember orange `#e07850`**, block style, `cursorInactiveStyle: "outline"`,
  blink on. Selection `rgba(224,120,80,0.25)`.
- Built-in scrollbar hidden (fit addon reserves width otherwise).

### 1.7 Code editor (CodeMirror 6) — `WorkspaceView/components/CodeEditor/createCodeMirrorTheme.ts` + `shared/themes/editor-theme.ts`

Editor theme is **derived from the app theme**:

- background/foreground = app background/foreground; gutter bg = background,
  gutter fg = muted-foreground, `borderRight: 1px solid border`.
- activeLine = `accent @ 50%`; selection = terminal selection color; search =
  `--highlight-match` / `--highlight-active`; cursor = terminal cursor (orange).
- Syntax colors map from the ANSI palette: comment→brightBlack `#5c5856`
  (ember overrides to `#a8a5a3`), keyword→magenta, string→green, number/class→yellow,
  function→blue, type/constant→cyan, tag/regexp→red, plain text→foreground.
- `.cm-content` padding `8px 0`, `.cm-line` padding `0 12px`.
- Search/panel chrome uses card/border/secondary tokens.

### 1.8 Icons & motion

- **lucide-react** (plus react-icons/lu in places), monochrome, default 16px
  (`size-4`) in buttons, 14px (`size-3.5`) in compact chrome, colored only by
  text color (`text-muted-foreground` → `hover:text-foreground`). **No colored
  icon tiles anywhere.**
- Motion: `transition-colors 0.15s ease` almost everywhere; toolbar controls
  fade in on hover/focus; dialogs/menus use fade+zoom-95; nothing bouncy.

---

## 2. Design decisions for WPHerd (locked)

1. **Adopt ember as the dark theme, Superset light as the light theme.** Keep
   WPHerd's existing behavior of following the macOS appearance via
   `prefers-color-scheme` (`darkMode: 'media'`, `nativeTheme` untouched). No
   in-app theme switcher, no theme store. Dark values live in the
   `@media (prefers-color-scheme: dark)` block (WPHerd's existing pattern),
   not under a `.light` class.
2. **Opaque window.** Remove transparency + vibrancy. This retires the entire
   Liquid Glass system (`.glass`, translucent tints, `--glass-*` tokens).
3. **Blue stays the brand color.** `--highlight` is WPHerd's existing accent
   blue (`#0a60ff` light / `#0a84ff` dark), **not** Superset's ember orange —
   used for the terminal cursor, selections, unread/dirty dots, progress
   accents, the active sidebar pill, and toggles. Primary buttons follow
   Superset's monochrome `default` variant; if blue primaries are preferred
   later, it's a one-line swap (`.btn-primary` → `bg-highlight
   text-highlight-foreground`).
   ⚠️ **Semantic trap:** in the new token set `--accent` means *neutral hover
   fill* (shadcn semantics), but in today's code `accent` means *blue*. Every
   existing `bg-accent` / `ring-accent` / `text-accent` call site must be
   re-pointed to `highlight` during the sweep, or it silently turns gray.
   Grep `accent` early and track the list.
4. **The sidebar keeps its colored icon tiles** (`IconTile` + `TILE_COLORS`)
   exactly as today — that's a deliberate WPHerd identity carve-out from
   Superset's all-monochrome iconography. `IconTile` stays a supported
   primitive (sidebar, PageHero, settings rows keep their tiles).
5. **No shadcn/ui dependency.** We port shadcn's *styling recipes* (which
   Superset uses) into WPHerd's existing primitives (`ui.jsx` + `.btn-*` /
   card classes). Do not add Radix, cva, clsx, or tailwind-merge.
6. **Keep the existing component seam:** pages keep composing `Button`, `Card`,
   `Row`, `PageHeader`, etc. from `src/components/ui.jsx` and the `.btn-*` /
   card classes in `src/index.css`. We restyle the primitives, then sweep pages
   for literal colors. This keeps the diff reviewable.
7. **Keep the gray-ramp compatibility trick** (gray-900 = primary text in both
   modes) but re-point the ramp + `surface*` vars at the Superset palette so
   all 350+ existing `text-gray-*` call sites land on-theme immediately. New
   code should prefer the new semantic utilities; the ramp is a migration shim.
8. Status colors standardize on Superset's run-pane trio: running `#10b981`,
   warning/stopped `#f59e0b`, error `#ef4444` (replaces `wp-green/orange/red`
   for status semantics; macOS traffic-light colors go away).

---

## 3. Phase 0 — Window chrome (`electron/main.cjs`)

File: `electron/main.cjs` (BrowserWindow options, currently
`titleBarStyle: 'hiddenInset'`, `trafficLightPosition {16,18}`,
`backgroundColor: '#00000000'`, `vibrancy: 'sidebar'`).

1. Remove `vibrancy` and `transparent`-style config; set
   `backgroundColor: nativeTheme.shouldUseDarkColors ? '#151110' : '#ffffff'`.
   Keep `titleBarStyle: 'hiddenInset'` and traffic-light position.
2. Listen for `nativeTheme.on('updated')` → `win.setBackgroundColor(...)` so the
   opaque backdrop flips with the system appearance (prevents a white flash in
   dark mode on relaunch/resize).
3. Delete any comments describing the vibrancy setup.

Verify: `npm run dev` — window is opaque warm-black in dark mode, white in light.

---

## 4. Phase 1 — Design tokens (`src/index.css` + `tailwind.config.js`)

### 4.1 New token block (replaces the current `:root` / dark block)

Keep WPHerd's **space-separated RGB triplet** format so Tailwind alpha
modifiers (`bg-card/60`) keep working. Light values first, ember dark in the
media query. Convert Superset's oklch light values to their RGB equivalents:

```css
:root {
  color-scheme: light;

  /* Superset semantic palette — light */
  --background: 255 255 255;
  --foreground: 37 37 37;        /* oklch(.145) */
  --card: 247 247 247;           /* oklch(.97) */
  --card-foreground: 37 37 37;
  --popover: 255 255 255;
  --popover-foreground: 37 37 37;
  --primary: 52 52 52;           /* oklch(.205) */
  --primary-foreground: 251 251 251;
  --secondary: 247 247 247;
  --secondary-foreground: 52 52 52;
  --muted: 247 247 247;
  --muted-foreground: 130 130 130; /* oklch(.556) */
  --accent: 236 236 236;         /* oklch(.93) — hover fill */
  --accent-foreground: 52 52 52;
  --tertiary: 240 238 237;       /* oklch(.95 .003 40) — toolbars/wells */
  --tertiary-active: 226 223 221;
  --destructive: 220 38 38;
  --destructive-foreground: 251 251 251;
  --border: 231 231 231;         /* oklch(.922) */
  --input: 231 231 231;
  --ring: 178 178 178;           /* oklch(.708) */
  --sidebar: 250 250 250;        /* oklch(.985) */
  --sidebar-foreground: 37 37 37;
  --sidebar-accent: 240 238 237; /* hover/active fill */
  --sidebar-border: 231 231 231;
  --highlight: 10 96 255;        /* WPHerd blue (kept) */
  --highlight-foreground: 255 255 255;
  --highlight-match: rgba(255, 211, 61, 0.35);   /* search: yellow reads best in light */
  --highlight-active: rgba(10, 96, 255, 0.35);

  /* Status */
  --status-running: 16 185 129;   /* #10b981 */
  --status-warning: 245 158 11;   /* #f59e0b */
  --status-error: 239 68 68;      /* #ef4444 */

  --radius: 10px;

  /* Compatibility shims — existing utilities keep working, now on-palette.
     gray-900 stays "primary text", gray-50 stays "subtle fill". */
  --gray-50: 247 247 247;
  --gray-100: 240 240 240;
  --gray-200: 231 231 231;
  --gray-300: 209 209 209;
  --gray-400: 161 161 161;
  --gray-500: 130 130 130;
  --gray-600: 95 95 95;
  --gray-700: 70 70 70;
  --gray-800: 52 52 52;
  --gray-900: 37 37 37;
  --surface: 255 255 255;         /* → background */
  --surface-card: 247 247 247;    /* → card */
  --surface-border: 231 231 231;  /* → border */
  --surface-hairline: 235 235 235;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;

    /* ember */
    --background: 21 17 16;        /* #151110 */
    --foreground: 234 232 230;     /* #eae8e6 */
    --card: 32 30 28;              /* #201e1c */
    --card-foreground: 234 232 230;
    --popover: 32 30 28;
    --popover-foreground: 234 232 230;
    --primary: 234 232 230;        /* monochrome primary */
    --primary-foreground: 21 17 16;
    --secondary: 42 40 39;         /* #2a2827 */
    --secondary-foreground: 234 232 230;
    --muted: 42 40 39;
    --muted-foreground: 168 165 163; /* #a8a5a3 */
    --accent: 42 40 39;
    --accent-foreground: 234 232 230;
    --tertiary: 26 23 22;          /* #1a1716 */
    --tertiary-active: 37 34 32;   /* #252220 */
    --destructive: 204 68 68;      /* #cc4444 */
    --destructive-foreground: 255 204 204;
    --border: 42 40 39;
    --input: 42 40 39;
    --ring: 58 56 55;              /* #3a3837 */
    --sidebar: 26 23 22;           /* #1a1716 */
    --sidebar-foreground: 234 232 230;
    --sidebar-accent: 37 34 32;    /* #252220 */
    --sidebar-border: 42 40 39;
    --highlight: 10 132 255;       /* WPHerd blue, dark-mode variant (kept) */
    --highlight-foreground: 255 255 255;
    --highlight-match: rgba(10, 132, 255, 0.22);
    --highlight-active: rgba(10, 132, 255, 0.45);

    /* Compatibility shims — warm-tinted ramp derived from ember neutrals */
    --gray-50: 32 30 28;
    --gray-100: 42 40 39;
    --gray-200: 55 52 50;
    --gray-300: 70 67 65;
    --gray-400: 122 119 117;
    --gray-500: 150 147 145;
    --gray-600: 168 165 163;
    --gray-700: 198 195 193;
    --gray-800: 220 218 216;
    --gray-900: 234 232 230;
    --surface: 21 17 16;
    --surface-card: 32 30 28;
    --surface-border: 42 40 39;
    --surface-hairline: 42 40 39;
  }
}
```

Delete: `--sidebar-hover`, `--accent-hover`, `--shadow-card(-hover)`,
`--glass-border`, `--glass-highlight`, `--shadow-glass` (grep for usages as you
go; they all die in Phases 2–3).

### 4.2 `tailwind.config.js`

Replace the `colors` block with the semantic set (all
`rgb(var(--x) / <alpha-value>)`):

```js
colors: {
  background: 'rgb(var(--background) / <alpha-value>)',
  foreground: 'rgb(var(--foreground) / <alpha-value>)',
  card: { DEFAULT: 'rgb(var(--card) / <alpha-value>)', foreground: 'rgb(var(--card-foreground) / <alpha-value>)' },
  popover: { DEFAULT: 'rgb(var(--popover) / <alpha-value>)', foreground: 'rgb(var(--popover-foreground) / <alpha-value>)' },
  primary: { DEFAULT: 'rgb(var(--primary) / <alpha-value>)', foreground: 'rgb(var(--primary-foreground) / <alpha-value>)' },
  secondary: { DEFAULT: 'rgb(var(--secondary) / <alpha-value>)', foreground: 'rgb(var(--secondary-foreground) / <alpha-value>)' },
  muted: { DEFAULT: 'rgb(var(--muted) / <alpha-value>)', foreground: 'rgb(var(--muted-foreground) / <alpha-value>)' },
  accent: { DEFAULT: 'rgb(var(--accent) / <alpha-value>)', foreground: 'rgb(var(--accent-foreground) / <alpha-value>)' },
  tertiary: { DEFAULT: 'rgb(var(--tertiary) / <alpha-value>)', active: 'rgb(var(--tertiary-active) / <alpha-value>)' },
  destructive: { DEFAULT: 'rgb(var(--destructive) / <alpha-value>)', foreground: 'rgb(var(--destructive-foreground) / <alpha-value>)' },
  border: 'rgb(var(--border) / <alpha-value>)',
  input: 'rgb(var(--input) / <alpha-value>)',
  ring: 'rgb(var(--ring) / <alpha-value>)',
  sidebar: {
    DEFAULT: 'rgb(var(--sidebar) / <alpha-value>)',
    foreground: 'rgb(var(--sidebar-foreground) / <alpha-value>)',
    accent: 'rgb(var(--sidebar-accent) / <alpha-value>)',
    border: 'rgb(var(--sidebar-border) / <alpha-value>)',
  },
  highlight: { DEFAULT: 'rgb(var(--highlight) / <alpha-value>)', foreground: 'rgb(var(--highlight-foreground) / <alpha-value>)' },
  status: {
    running: 'rgb(var(--status-running) / <alpha-value>)',
    warning: 'rgb(var(--status-warning) / <alpha-value>)',
    error: 'rgb(var(--status-error) / <alpha-value>)',
  },
  // migration shims — keep until the page sweep (Phase 5) finishes
  gray: { 50:…, 100:…, …900 },            // unchanged var wiring
  surface: { DEFAULT:…, card:…, border:…, hairline:… }, // unchanged wiring
},
borderRadius: {
  DEFAULT: 'var(--radius)',      // 10px
  sm: 'calc(var(--radius) - 4px)',
  md: 'calc(var(--radius) - 2px)',
  lg: 'var(--radius)',
  xl: 'calc(var(--radius) + 4px)',
},
fontFamily: {
  sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Helvetica', 'Arial', 'sans-serif'],
  mono: ['"JetBrains Mono"', '"SF Mono"', 'ui-monospace', 'Menlo', 'Monaco', 'monospace'],
},
```

Remove `wp.*` colors and `boxShadow.card/card-hover/window`. Keep animations.

**`accent` re-pointing (from §2.3):** before deleting the old blue `accent`
mapping, `grep -rn "accent" src/` and re-point every call site that *means
blue* to `highlight`: the sidebar active pill (`bg-sidebar-active` /
`bg-accent`), search-field focus rings (`ring-accent/40`), `Toggle` checked
state, `StepIndicator` active step, and any `text-accent` links. Keep a
`sidebar.active: 'rgb(var(--highlight) / <alpha-value>)'` alias so
`bg-sidebar-active` keeps working. After re-pointing, `accent` is exclusively
the neutral shadcn hover fill.
**Caution:** overriding `borderRadius` affects every existing `rounded-*`
utility — `rounded-md` becomes 8px (was 6px), `rounded-xl` 14px (was 12px).
That's intended (Superset's scale); just be aware when eyeballing diffs.

### 4.3 Base styles (same file)

- Body: `@apply font-sans overflow-hidden select-none bg-background text-foreground;`
  (no more `background: transparent`).
- Scrollbars → Superset spec: width/height **10px** (12 is heavy for this app),
  transparent track, thumb `rgb(var(--muted-foreground) / 0.35)` with
  `border: 3px solid transparent; background-clip: padding-box; border-radius: 6px`,
  hover 0.55. Add `.scrollbar-thin` (6px/2px) for the file tree.
- Global focus style: replace the current blue `ring-wp-blue` input rule with
  `outline-none ring-[3px] ring-ring/50 border-ring` on focus.

Verify after Phase 1: app runs; everything already looks warm-dark/neutral-light
(via the shims) even before components are touched. `npm run lint` clean.

---

## 5. Phase 2 — Primitive restyle (`src/index.css` + `src/components/ui.jsx`)

### 5.1 Buttons (`.btn*` in index.css)

Superset shape — **rounded-md, not capsule**:

```css
.btn {
  @apply inline-flex items-center justify-center gap-1.5 rounded-md font-medium
    transition-all duration-150 px-3 h-8 text-[13px] leading-none
    disabled:opacity-50 disabled:cursor-not-allowed
    focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50;
}
.btn-primary   { @apply btn bg-primary text-primary-foreground hover:bg-primary/90; }
.btn-secondary { @apply btn border border-border bg-background shadow-sm hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:hover:bg-input/50; }  /* = Superset "outline" */
.btn-danger    { @apply btn bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/70; }
.btn-ghost     { @apply btn text-muted-foreground hover:bg-accent hover:text-accent-foreground; }
```

Update the button conventions: icons stay `size={14} strokeWidth={2}` at call
sites is acceptable, but the Superset default is 16px — pick **14px** app-wide
(closer to current 12 and fits `h-8`). Drop the `Play fill` convention if it
fights the monochrome look (keep if it reads better). Remove all `min-h-[32px]`
capsule references from comments.

### 5.2 Cards

Rename in place (keep the class name to avoid a 60-file rename):

```css
.settings-card {
  @apply rounded-xl border border-border bg-card shadow-sm overflow-hidden;
}
.settings-row { /* unchanged layout */ }
.settings-row + .settings-row, .settings-row-divider { @apply border-t border-border; }
.settings-row-btn { @apply w-full text-left transition-colors hover:bg-accent/50 active:bg-accent; }
.settings-section-label { @apply text-[13px] font-semibold text-foreground mb-2 px-1; }
```

No backdrop-filter anywhere. `site-card:hover` keeps the lift but swap shadow:
`hover:shadow-md hover:-translate-y-0.5` and add `hover:border-ring/60`.

### 5.3 Panels, sheets, modals

- `.panel` / `.panel-menu` → `@apply bg-popover border border-border rounded-lg shadow-lg;`
  (menus: `p-1`, items get `rounded-sm px-2 py-1.5 text-[13px]`,
  destructive items `text-destructive hover:bg-destructive/10`).
- `.modal-overlay` → `bg-black/50`.
- `.sheet` → `@apply rounded-lg border border-border bg-background p-6 shadow-lg;`
  (kill the 26px radius + glass shadows). `.sheet-well` →
  `@apply rounded-lg bg-tertiary p-4 border border-border/60;`
- `.form-input` → mirror Superset input:
  `@apply w-full h-8 px-3 rounded-md border border-input bg-transparent text-[13px]
   text-foreground placeholder:text-muted-foreground shadow-sm transition-colors
   dark:bg-input/30 focus:border-ring focus:ring-[3px] focus:ring-ring/50;`

### 5.4 ui.jsx component updates

- **Toggle** → Superset switch dims, WPHerd color: track `w-8 h-[18px]`,
  thumb `w-4 h-4 bg-white shadow-sm`, checked `bg-highlight` (blue — macOS
  familiar, per §2.3), unchecked `bg-input`.
- **IconTile / PageHero — KEEP.** `IconTile` and both `TILE_COLORS` maps stay
  (per §2.4). Only cosmetic alignment: tile radius/sizing unchanged; `PageHero`
  keeps its big colored tile but its card becomes the flat §5.2 card and its
  text goes `text-foreground` / `text-muted-foreground`.
- **Tooltip** pill → `rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium`
  (drop capsule + `shadow-lg`; keep portal/placement logic). `Kbd` inside →
  `bg-background/20 rounded-sm h-5 min-w-5 px-1 text-xs`.
- **Kbd** (standalone) → `bg-muted text-muted-foreground rounded-sm h-5 min-w-5 px-1 text-[11px] font-medium`.
- **StepIndicator**: completed `bg-status-running`, active `bg-highlight text-highlight-foreground`,
  upcoming `bg-muted text-muted-foreground`; connectors `bg-border` → filled `bg-status-running`.
- **ProgressLog**: `bg-zinc-900` → `bg-background border border-border rounded-lg`
  with `font-mono text-xs`; spinner `text-highlight`, check `text-status-running`.
  (Terminal-style panels now share the app background — Superset terminals are
  not separate dark boxes. Delete the CLAUDE.md rule about `bg-zinc-900`.)
- **ConfirmDialog**: panel classes from 5.3; overlay `bg-black/50`.
- **New `SegmentedTabs` component** (Superset tabs): container
  `inline-flex h-8 items-center rounded-lg bg-muted p-[3px]`, buttons
  `h-full px-3 rounded-[7px] text-[13px] font-medium text-muted-foreground
   data-active:bg-background data-active:text-foreground data-active:shadow-sm`.
  Use it in Phase 5 wherever pages hand-roll tab switchers (SiteDetail,
  WpPlugins/WpThemes filters, Mail folders — check each).
- **StatusBadge** (`StatusBadge.jsx`): dot + label chip →
  `rounded-full border px-2 py-0.5 text-xs font-medium` with the status trio:
  running `text-status-running border-status-running/30 bg-status-running/10`,
  stopped `text-muted-foreground border-border bg-muted`, error
  `text-status-error border-status-error/30 bg-status-error/10`.

Verify: `npm run dev`, click through Dashboard/Sites/Services/Settings — all
controls flat + bordered, both modes. `npm run test` (procman/services tests
unaffected but run anyway).

---

## 6. Phase 3 — Layout & sidebar (`src/components/Layout.jsx`, `AgentsSidebar.jsx`)

1. Sidebar `<aside>`: `bg-sidebar border-r border-sidebar-border` (opaque; no
   more raw vibrancy). Width stays `w-56`.
2. Nav items — Superset row metrics, **WPHerd tiles and blue pill kept** (§2.4):
   ```
   base:   flex items-center gap-2.5 px-2 py-[5px] rounded-md text-[13px]
           text-sidebar-foreground/90
   hover:  hover:bg-sidebar-accent
   active: bg-sidebar-active text-white font-medium   (blue pill, as today;
           bg-sidebar-active now aliases --highlight)
   icon:   the existing 22px colored `icon-tile` span (active: bg-white/25,
           unchanged)
   ```
   The `TILE_COLORS` map and tile spans stay exactly as they are — only the
   hover fill changes from literal `bg-black/[0.05] dark:bg-white/[0.07]` to
   the `bg-sidebar-accent` token.
3. Search field: `h-7 rounded-md bg-muted border-0 text-[13px] pl-8
   placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/60` (rectangular,
   not capsule).
4. Main pane: `bg-background` (remove `bg-surface/55`). Remove the
   `border-black/[0.06] dark:border-white/[0.06]` literal on the aside (now
   `border-sidebar-border`).
5. Window control cluster (sidebar toggle, back/forward): keep positions;
   restyle to `rounded-md text-muted-foreground hover:text-foreground
   hover:bg-accent` (drop literal black/white hovers).
6. `AgentsSidebar.jsx`: same treatment — tree rows `text-[13px]`, hover
   `bg-sidebar-accent`, selection `bg-sidebar-active text-white` where it uses
   the nav-pill pattern, section headers `text-[11px] font-medium uppercase
   tracking-wider text-muted-foreground` (Superset section style). Icons here
   are functional (chevrons, git glyphs) — keep them monochrome.

---

## 7. Phase 4 — Terminal & code editor theming

### 7.1 New shared theme module — `src/lib/theme.js`

Export the ember/light palettes as JS (single source for xterm + CodeMirror):

```js
export const terminalThemes = {
  dark: {
    background: '#151110', foreground: '#eae8e6',
    cursor: '#0a84ff', cursorAccent: '#151110',   /* WPHerd blue (kept) */
    selectionBackground: 'rgba(10,132,255,0.28)',
    black:'#151110', red:'#dc6b6b', green:'#7ec699', yellow:'#e5c07b',
    blue:'#61afef', magenta:'#c678dd', cyan:'#56b6c2', white:'#eae8e6',
    brightBlack:'#5c5856', brightRed:'#e88888', brightGreen:'#98d1a8',
    brightYellow:'#ecd08f', brightBlue:'#7ec0f5', brightMagenta:'#d494e6',
    brightCyan:'#73c7d3', brightWhite:'#ffffff',
  },
  light: { /* xterm defaults from Superset light.ts:
    background '#ffffff', foreground '#000000', cursor '#000000',
    selectionBackground '#add6ff', black '#2e3436', red '#cc0000',
    green '#4e9a06', yellow '#c4a000', blue '#3465a4', magenta '#75507b',
    cyan '#06989a', white '#d3d7cf', bright: '#555753' '#ef2929' '#8ae234'
    '#fce94f' '#729fcf' '#ad7fa8' '#34e2e2' '#eeeeec' */ },
};
export const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
```

### 7.2 `src/components/Terminal.jsx`

- Options → Superset spec:
  `fontFamily: '"JetBrains Mono", "JetBrainsMono Nerd Font", "MesloLGS NF", "SF Mono", Menlo, Monaco, monospace'`,
  `fontSize: 13`, `cursorBlink: true`, `cursorStyle: 'block'`,
  `cursorInactiveStyle: 'outline'`, `theme: terminalThemes[isDark() ? 'dark' : 'light']`.
- Wrapper div: drop `rounded-xl bg-[#1c1c1e]`; terminal sits flush on
  `bg-background` (padding `p-2` stays). React to appearance change: listen to
  the media query and `term.options.theme = …` on flip.
- "Session ended" overlay: `.panel` classes already restyled in Phase 2.

### 7.3 `src/components/CodeEditor.jsx` + new `src/lib/editorTheme.js`

Replace the fixed `oneDarkPro` import with a token-faithful port of Superset's
`getEditorTheme` using `createTheme` from `@uiw/codemirror-themes` (already a
dependency). Build **two themes** from the palettes above:

Dark (ember):
```
background/gutterBackground: #151110   foreground: #eae8e6
gutterForeground: #a8a5a3              lineHighlight: rgba(42,40,39,0.5)
selection: rgba(10,132,255,0.28)       caret: #0a84ff
syntax: comment #a8a5a3 italic? no — plain
  keyword #c678dd · string #7ec699 · number/class #e5c07b
  function #61afef · type/constant #56b6c2 · tag/regexp #dc6b6b
  variableName/plain #eae8e6 · invalid #e88888
  propertyName #61afef · attributeName #e5c07b
```
Light: backgrounds `#ffffff`, gutter fg `#828282`, selection `#add6ff`,
caret `#000`, syntax from the light ANSI set (keyword `#75507b`, string
`#4e9a06`, number `#c4a000`, function `#3465a4`, type `#06989a`, tag `#cc0000`,
comment `#555753`).

Editor chrome in the component:
- Root/tab strip: replace `bg-[#282c34]`/`bg-[#21252b]`/zinc classes with
  tokens: root `bg-background text-foreground`; tab strip `h-9 bg-tertiary
  border-b border-border`; tab `text-[12.5px] text-muted-foreground border-r
  border-border`, active `bg-background text-foreground`; hover controls
  `hover:bg-accent`. Dirty dot `bg-highlight`. (This matches the mosaic
  toolbar spec: tertiary chrome, background content.)
- Header action buttons: `text-muted-foreground hover:text-foreground hover:bg-accent rounded-md`.
- Pass `style={{ fontSize: 13 }}` / keep `text-[12.5px]`→13px, and set
  CodeMirror `fontFamily` to the mono stack (via the createTheme settings
  `fontFamily` field). Line padding: add `.cm-line { padding: 0 12px }` and
  content `8px 0` via the theme's `styles`/`EditorView.theme` if `createTheme`
  settings allow (or a small `EditorView.theme` extension appended alongside).
- Select theme by `isDark()`; re-render on media-query change (a tiny
  `useSyncExternalStore` or state + listener).
- Delete `src/lib/oneDarkPro.js` once nothing imports it.

### 7.4 Other terminal-ish surfaces

`SiteLogs.jsx`, `AgentsPane.jsx` log panes, `ProgressLog`: same rule —
`bg-background` (or `bg-tertiary` for wells) + `border-border` + mono stack +
ANSI-derived accent colors. No `bg-zinc-900` anywhere (grep it).

---

## 8. Phase 5 — Page sweep

Goal: remove every literal color and glass remnant. Grep targets, in order:

```
backdrop-blur | backdrop-filter | \.glass | bg-white/ | bg-black/ |
dark:bg-white | dark:hover:bg-white | bg-zinc- | text-zinc- | bg-[# | text-[# |
wp-blue | wp-green | wp-red | wp-orange | shadow-card | IconTile | icon-tile
```

Per-file notes (sizes are current line counts, biggest risk first):

- **FileExplorer.jsx (1416)** — tree rows: `text-[13px]`, hover `bg-accent/50`,
  selected `bg-accent text-foreground`; git decorations: modified
  `text-status-warning`, added `text-status-running`, deleted
  `text-status-error`, untracked `text-highlight`; context menu = `.panel-menu`
  spec. Use `.scrollbar-thin`.
- **Mail.jsx (703)** — inbox list = card rows; unread dot `bg-highlight`;
  folder chips → `SegmentedTabs`; iframe container `bg-card border-border`.
- **WpPlugins/WpThemes (625/617)** — filter tabs → `SegmentedTabs`; status
  chips → StatusBadge recipe; action buttons already `.btn-*`.
- **SiteDetail/SiteCard (491/482)** — running indicator: dot `bg-status-running`
  + optional Superset run-pane treatment on the card:
  `border-color: color-mix(in srgb, rgb(var(--status-running)) 25%, rgb(var(--border)))`
  while the site is running (add a `.card-running` rule in index.css).
  Screenshot/favicon wells → `bg-tertiary`.
- **Settings/Services/PHPVersions/PhpSettings/SitePhpSettings** — rows keep
  `Row`; version pills → Badge recipe (`rounded-full border px-2 text-xs`);
  the dnsmasq sudo callout → `bg-highlight/10 text-highlight border-highlight/30`
  tint box; destructive rows `text-destructive`.
- **Dashboard.jsx** — stat tiles = `.settings-card` + `text-2xl font-semibold`
  numbers, `text-xs text-muted-foreground` labels; chart colors (if/when):
  chart-1..5 from §1.2.
- **Onboarding.jsx** — hero panel `bg-card border rounded-xl`; StepIndicator
  restyled in Phase 2; CTA `btn-primary` (now monochrome).
- **AddSite/Import/Clone/ChangeUrl/SaveBlueprint modals** — `.sheet` restyle
  lands automatically; inside, swap any literal grays; wells → `.sheet-well`.
- **AgentsPane/AgentsSidebar** — pane toolbars: `h-7 bg-tertiary border-b
  border-border text-[11px] font-medium text-muted-foreground tracking-[0.01em]`,
  focused pane title `text-foreground` (mosaic spec §1.3); pane borders
  `border-border`; running-agent tint via the color-mix rule above.
- **StatusBadge.jsx, icons.jsx** — finish anything left from Phase 2.

`dark:` variants: after the sweep the only legitimate `dark:` usages left are
literal-tint boxes (e.g. `bg-red-50 …` → replace with token tints like
`bg-destructive/10 text-destructive` which need **no** dark variant) and the
Superset-style `dark:bg-input/30` on inputs/outline buttons. Target: reduce
`dark:` count from ~249 to <30.

---

## 9. Phase 6 — Docs & cleanup

1. **Rewrite the "Renderer UI conventions" section of `CLAUDE.md`**: delete the
   Liquid Glass and System Settings paragraphs; document the Superset token
   system (semantic tokens, monochrome primary, highlight orange, flat bordered
   cards, segmented tabs, status trio, mono stack, terminal/editor theme
   derivation, scrollbar util). Keep the dark-mode gray-ramp note only if the
   shim ramp is still referenced; state it's deprecated for new code.
2. Delete dead code: `.glass`, `.backdrop-macos`, glass tokens, `oneDarkPro.js`,
   `wp.*` Tailwind colors, `boxShadow.card*`. (`IconTile`/`TILE_COLORS` stay —
   §2.4.)
3. `grep -r "backdrop-filter\|vibrancy\|glass" src electron` → zero hits
   (except node_modules/reference).
4. Run `npm run lint:fix`, `npm run format`, `npm run test`, `npm run dev`
   visual pass in **both** appearances (System Settings → Appearance toggle).

---

## 10. Acceptance checklist

- [ ] Window opaque; no vibrancy; no white flash switching appearance.
- [ ] Dark mode is ember (`#151110` bg, warm text, `#2a2827` borders); light is
      neutral white/oklch-gray. Both react live to macOS appearance.
- [ ] All buttons rounded-md, 4 variants matching §5.1; primary is monochrome.
- [ ] Cards flat: `bg-card border border-border rounded-xl shadow-sm`.
- [ ] Sidebar opaque `bg-sidebar`; colored icon tiles + blue active pill kept;
      hover uses `bg-sidebar-accent`.
- [ ] No capsule buttons; no frosted/glass panels; `accent` utilities audited
      (nothing that means "blue" still says `accent`).
- [ ] Terminal: JetBrains Mono stack 13px, ember ANSI palette, **blue** block
      cursor, background = app background, theme flips with appearance.
- [ ] Code editor: token-derived theme both modes, tertiary tab strip, 13px mono.
- [ ] Tooltips `bg-foreground text-background rounded-md`; menus/dialogs on
      popover surface with `shadow-md/lg`.
- [ ] Status colors everywhere = `#10b981 / #f59e0b / #ef4444`.
- [ ] `npm run lint` + `npm run test` pass; CLAUDE.md updated; dead code gone.

## 11. Out of scope

- Theme switcher UI / custom theme import (Superset has one; WPHerd follows the
  OS — revisit later).
- `superset-font://`-style SF Mono protocol loading (stack falls back to Menlo
  fine; JetBrains Mono users get the upgrade automatically).
- Any main-process service logic, tray icon, IPC surface, or store schema.
- Marketing/site assets, app icon.
