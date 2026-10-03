# Assets

The "Spark X" mark: an X whose rising stroke lets go of a spark, in WPXen
blue `#0A60FF`.

- `icon.icns` — macOS app icon. A blue tile on Apple's 1024 grid (824 px
  body, mark at 60 % of the tile). The 16 and 32 px sizes are hand-tuned:
  a fuller tile (14 / 26 px, radius 3 / 6) with a bigger mark in the heavier
  small cut (10 / 17 px), and no shadow.
- `tray.png` / `tray@2x.png` — menu-bar icon, 16 / 32 px. Black with alpha:
  `tray.cjs` marks it a template image, so macOS tints it for light and dark
  menu bars. Small cut: strokes 17 u, spark r 18 u.
- `icon.svg` (64 px and up), `icon-32.svg`, `icon-16.svg`, `tray.svg` — the
  sources the above are rendered from.

The in-app logo is not an image: `src/components/BrandLogo.jsx` draws the
same mark plus the wordmark (Sora SemiBold, outlined) as inline SVG, so the
wordmark takes the theme's text color.

## Regenerating

Render each SVG to PNG at the needed sizes with any SVG renderer (e.g.
`@resvg/resvg-js`), then build the icon set:

```bash
# icon.iconset/ holds icon_16x16.png … icon_512x512@2x.png
iconutil -c icns icon.iconset -o icon.icns
```
