# Assets

Place the following icon files here for production builds:

- `icon.icns` — macOS app icon (512x512 recommended)
- `tray.png` — Menu bar tray icon (22x22 @1x, must be template image — monochrome black PNG)
- `tray@2x.png` — Retina tray icon (44x44 @2x)

## Generating icons

1. Create a 1024x1024 PNG source image
2. Use `iconutil` or `electron-icon-builder` to generate `.icns`
3. For the tray icon: use a simple monochrome 22x22 PNG (Electron sets it as a template image)

## Quick tray icon for development

If no tray.png is found, the app will run without a visible tray icon (the title "WP" will show instead).
