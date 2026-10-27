# WPXen Mobile

The native companion app for WPXen Remote Access (iOS and Android, Expo + React Native + TypeScript). Pair it with your Mac, see your Projects and Sessions live, open a Session's terminal and type into it, start or stop Sessions, and get a push when one needs you.

## Run it against a dev WPXen

1. In the desktop repo, open WPXen → Settings → Mobile, turn Remote Access on, save a tunnel token and hostname, and wait for “Reachable at …”.
2. Here: `npm install`, then `npm run ios` (Simulator) or `npm run android` (emulator), or `npm start` and scan the Metro QR with Expo Go (everything but push — see below).
3. On the Mac: Settings → Mobile → Pair a device. In the app: Add Mac → scan the QR (camera) or paste the pairing link (Simulator, accessibility). Check the 4-digit codes match, allow it on the Mac.

The phone reaches the Mac over its own Cloudflare tunnel; everything is end-to-end encrypted. Pairing exchanges long-term keys; every connection then derives its own keys from those plus fresh ephemeral keys and nonces from both ends (protocol v2, `shared/remote-protocol/handshake.cjs`), so nothing recorded off the wire can be replayed. The encrypted channel is the repo's shared protocol module (`../shared/remote-protocol/`, imported — never copied).

## Push notifications need a development build

Pairing, Sessions and the terminal work in Expo Go. Push does not: Expo Go can't carry this app's notification config or EAS project, and a push to a closed app needs the native build the `expo-notifications` plugin produces (`app.config.js` turns on background remote notifications). To get pushes:

1. `npx eas init` once, and note the project id it prints.
2. Build a development client with that id in the environment, on a physical device (simulators get no push token): `EAS_PROJECT_ID=<id> npx expo run:ios --device` (or `run:android`), or `EAS_PROJECT_ID=<id> npx eas build --profile development`.
3. For TestFlight / App Store builds also set `WPXEN_APS_ENVIRONMENT=production`; the default is the APNs sandbox, which only development builds use.

No project id is committed — `app.config.js` reads `EAS_PROJECT_ID`. Without it (or in Expo Go, or on a simulator, or with notifications denied) the app still runs, and its screen for that Mac says under "Notifications from this Mac" why no push will arrive.

## Scripts

- `postinstall` — bundles xterm.js (the desktop's version, pinned in `package.json`) into `src/terminal/terminalEngine.generated.ts`, which the terminal WebView inlines. It is gitignored; `npm install` / `npm ci` rebuild it. The terminal page loads nothing from the network.
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `expo lint`
- `npm run test` — `vitest run` (pure modules only: backoff, connection state and health, dial policy, network-change nudges, host list, grouping, list sync, push registration, key bar, resize policy, terminal document, Metro and app config)
- `npm run bundle:check` — bundles the app with Metro (`expo export --platform ios` into a temp dir) and fails if any import can't be resolved. Typecheck and vitest resolve through Node and miss this.

The root desktop gate (`lint`, `format:check`, `test`, `build:renderer`) ignores `mobile/`; CI runs the four scripts above in a separate `mobile` job.
