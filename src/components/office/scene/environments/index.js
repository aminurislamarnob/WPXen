import { lazy } from 'react';

// ── Environments ─────────────────────────────────────────────
// The world around the room, one component per `office.environment` value
// (catalogue and lighting in lib/office/scene/environments.js). OfficeScene
// renders exactly one, inside the Canvas, beside the room.
//
// ⚠️ Only the chosen world runs. Each is loaded on first use (a dynamic
// import, its own chunk), so the other five are never fetched, parsed or
// built — module-scope geometry included. Never import a world module
// statically: it would ship all of them into the Office bundle again
// (office-env-loading.test.js checks). When a world goes, OfficeScene frees
// everything it drew (disposeTree in common.jsx).
//
// Every environment receives:
//   plan     the floor plan (bounds minX/maxX/minZ/maxZ; the room's floor is
//            y = 0, its far edges are maxX + 1 / maxZ + 1, pods and desks
//            carry their positions). New every snapshot — memo on what you use.
//   kind     the room ('claude' | 'antigravity'); seed scenery on it.
//   look     the light of this moment (environmentLook): sky, fog, sun,
//            `day` (0..1 daylight), `windows` (0..1 night lights).
//   office   the room's sessions ({ sessions: { [pid]: Session } }); ended
//            ones linger a few seconds (play departures on state === 'ended').
//   events   recent agent moments ({ type, pid, id, at }) — arrived, left,
//            finished, error, waiting — stamped with Date.now(), kept ~9 s.
//   mood     standing counts { live, busy, waiting, error } for weather.
//   onSelect ({ pid }) focuses an agent: wrap its world object in Clickable.
//
// And keeps these rules:
// - ⚠️ Nothing between the camera and the room. The camera's azimuth range
//   keeps it in the +x/+z quadrant, so every sight line from the room to the
//   camera heads toward +x and +z (and up). Above the floor (y > 0), scenery
//   must therefore lie entirely behind the back wall (z ≤ minZ − wall, at any
//   x) or entirely beyond the left wall (x ≤ minX − wall, at any z): no sight
//   line can reach it. Everywhere else it stays below y = 0.
//   (lib/office/scene/city.js mayRise is stricter than this, and correct.)
// - Something under the room: the floor slab ends at y = -SLAB_DEPTH (0.35);
//   draw the structure it stands on from there down, or the room floats.
// - Outdoors stays out of the shadow map (no castShadow / receiveShadow), and
//   repeats are instanced (useInstances) — the room's perf budget holds.
// - No lights of its own: the room's are the scene's. One more light, even at
//   intensity 0, makes every material in the room compile a variant for it
//   and evaluate it per pixel on every frame. Brighten or tint through the
//   look, shared uniforms, or scene.environmentIntensity / backgroundIntensity
//   (the Cyberpunk lightning does), and put those back when done.
// - Animate in useFrame with scratch objects: no allocation, no setState per
//   frame. The scene renders at the environment's `ambientFps` at least, so
//   ambient motion needs no invalidate().
// - Colours of the world's own surfaces follow `look` (dayFactor, uniforms),
//   so the room's lighting and the world's agree at every hour.

/** Each world's module, loaded on demand. */
export const ENVIRONMENT_LOADERS = {
  city: () => import('./City.jsx').then((m) => ({ default: m.City })),
  space: () => import('./Space.jsx').then((m) => ({ default: m.Space })),
  island: () => import('./Island.jsx').then((m) => ({ default: m.Island })),
  underwater: () => import('./Underwater.jsx').then((m) => ({ default: m.Underwater })),
  cyberpunk: () => import('./Cyberpunk.jsx').then((m) => ({ default: m.Cyberpunk })),
  green: () => import('./Green.jsx').then((m) => ({ default: m.Green })),
};

/**
 * The worlds as lazy components: rendering one suspends until its module has
 * loaded, so wrap it in a Suspense boundary of its own.
 * @type {Record<string, import('react').ComponentType<any>>}
 */
export const ENVIRONMENT_COMPONENTS = Object.fromEntries(
  Object.entries(ENVIRONMENT_LOADERS).map(([id, load]) => [id, lazy(load)])
);
