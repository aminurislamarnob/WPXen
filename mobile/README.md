# WPXen Mobile

The native companion app for WPXen Remote Access (iOS and Android, Expo + React Native + TypeScript). Pair it with your Mac, see your Projects and Sessions live, open a Session's terminal and type into it, start or stop Sessions, and get a push when one needs you.

## Run it against a dev WPXen

1. In the desktop repo, open WPXen → Settings → Mobile, turn Remote Access on, save a tunnel token and hostname, and wait for “Reachable at …”.
2. Here: `npm install`, then `npm run ios` (Simulator) or `npm run android` (emulator), or `npm start` and scan the Metro QR with Expo Go.
3. On the Mac: Settings → Mobile → Pair a device. In the app: Add Mac → scan the QR (camera) or paste the pairing link (Simulator, accessibility). Check the 4-digit codes match, allow it on the Mac.

The phone reaches the Mac over its own Cloudflare tunnel; everything is end-to-end encrypted. Pairing exchanges long-term keys; every connection then derives its own keys from those plus fresh ephemeral keys and nonces from both ends (protocol v2, `shared/remote-protocol/handshake.cjs`), so nothing recorded off the wire can be replayed. The encrypted channel is the repo's shared protocol module (`../shared/remote-protocol/`, imported — never copied).

## Scripts

- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `expo lint`
- `npm run test` — `vitest run` (pure modules only: backoff, connection state, host list, grouping, list sync, key bar, resize policy, terminal document, Metro config)
- `npm run bundle:check` — bundles the app with Metro (`expo export --platform ios` into a temp dir) and fails if any import can't be resolved. Typecheck and vitest resolve through Node and miss this.

The root desktop gate (`lint`, `format:check`, `test`, `build:renderer`) ignores `mobile/`; CI runs the four scripts above in a separate `mobile` job.
