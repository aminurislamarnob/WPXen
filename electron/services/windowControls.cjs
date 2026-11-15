// Where the macOS traffic lights sit. The default clears the 48px title area
// of most screens; the Agents screen runs a 40px top bar (Orca-style), so the
// lights move up onto its centre line. macOS draws the 12px lights about 2px
// below the configured y, so their centre is y + 8: 26 by default, 20 on
// Agents. Pure, so it is testable; ipc.cjs applies it with
// BrowserWindow.setWindowButtonPosition.

const TRAFFIC_LIGHTS = {
  default: { x: 16, y: 18 },
  agents: { x: 16, y: 12 },
};

/** @param {string} layout */
function trafficLightsFor(layout) {
  return TRAFFIC_LIGHTS[layout] ?? TRAFFIC_LIGHTS.default;
}

module.exports = { TRAFFIC_LIGHTS, trafficLightsFor };
