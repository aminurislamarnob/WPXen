# WPXen Mobile

The native companion app for WPXen Remote Access (iOS and Android, Expo + React Native + TypeScript). Pair it with your Mac and see that it is connected. Sessions arrive in later tickets.

## Run it against a dev WPXen

1. In the desktop repo, open WPXen → Settings → Mobile, turn Remote Access on, save a tunnel token and hostname, and wait for “Reachable at …”.
2. Here: `npm install`, then `npm run ios` (Simulator) or `npm run android` (emulator), or `npm start` and scan the Metro QR with Expo Go.
3. On the Mac: Settings → Mobile → Pair a device. In the app: Add Mac → scan the QR (camera) or paste the pairing link (Simulator, accessibility). Check the 4-digit codes match, allow it on the Mac.

The phone reaches the Mac over its own Cloudflare tunnel; everything is end-to-end encrypted with the device key from pairing. The encrypted channel is the repo's shared protocol module (`../shared/remote-protocol/`, imported — never copied).

## Scripts

- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `expo lint`
- `npm run test` — `vitest run` (pure modules only: backoff, connection state, host list)

The root desktop gate (`lint`, `format:check`, `test`, `build:renderer`) ignores `mobile/` and runs only there.
