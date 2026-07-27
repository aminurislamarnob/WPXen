# Assets

Icon files used by production builds:

- `icon.svg` — vector source for the app mark: the blue tile and paper plane
- `icon.icns` — macOS app icon, rendered from `icon.svg` (32 → 1024px)
- `tray.png` — Menu bar tray icon (22x22 @1x, must be template image — monochrome black PNG)
- `tray@2x.png` — Retina tray icon (44x44 @2x)

The same mark appears as a lockup with the wordmark in `src/assets/logo.svg`,
which is what the sidebar, onboarding and splash render. Keep the three in
sync — the plane geometry is shared.

## Generating icons

1. Export `icon.svg` to a 1024x1024 PNG (plus 512/256/128/64/32)
2. Use `iconutil` or `electron-icon-builder` to generate `.icns`
3. For the tray icon: render the plane alone, solid black, at 22x22 and 44x44 with a transparent background (Electron sets it as a template image, so only the alpha channel matters)

## Quick tray icon for development

If no tray.png is found, the app will run without a visible tray icon (the title "WP" will show instead).
