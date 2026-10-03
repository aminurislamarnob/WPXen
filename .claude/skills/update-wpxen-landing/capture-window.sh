#!/usr/bin/env bash
# Capture WPXen's main window, without its drop shadow, at full Retina size.
# Usage: capture-window.sh <out.png>
#
# screencapture needs a CGWindowID, which no CLI exposes, so a few lines of
# Swift look it up by the window's title. The terminal running this needs
# Screen Recording permission (System Settings > Privacy & Security);
# without it the capture comes out as wallpaper only.
set -euo pipefail
out="${1:?usage: capture-window.sh <out.png>}"

id=$(swift - <<'SWIFT'
import CoreGraphics
let wins = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in wins where (w[kCGWindowOwnerName as String] as? String) == "WPXen"
  && (w[kCGWindowLayer as String] as? Int) == 0
  && ((w[kCGWindowName as String] as? String) ?? "").hasPrefix("WPXen") {
  print(w[kCGWindowNumber as String]!)
  break
}
SWIFT
)

if [ -z "$id" ]; then
  echo "No on-screen WPXen window found. Is the app open with its window visible?" >&2
  exit 1
fi
screencapture -x -o -l"$id" "$out"
sips -g pixelWidth -g pixelHeight "$out" | tail -2
