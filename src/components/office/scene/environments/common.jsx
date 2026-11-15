import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { CAMERA_DISTANCE } from '../../../../lib/office/scene/environments.js';
import { FLOOR_H } from '../../../../lib/office/scene/city.js';
import { skyTexture } from '../../../../lib/office/scene/textures.js';

// ── Environment kit ──────────────────────────────────────────
// What every environment (scene/environments/*.jsx) builds from:
//
// - exteriorMaterial: a MeshStandardMaterial with height haze injected (the
//   deeper below the office floor, the more of the fog colour it takes on),
//   and optionally a window grid drawn in the shader for instanced buildings.
// - useInstances: one InstancedMesh for many copies of one shape, one colour
//   each, freed when its items change.
// - Atmosphere: the sky (a time-of-day gradient texture with stars) and the
//   distance fog, both from the environment's Look.
// - Clickable: makes a world object focus its agent, with a pointer cursor.
// - disposeTree: frees a departing world's GPU resources (OfficeScene).
// - eventsFor / eventAge: read the agent-event queue (lib/office/agentEvents).
//
// The rules every environment keeps — nothing between the camera and the room,
// nothing outdoors in the shadow map, no per-frame allocations — are spelled
// out in ./index.js.

/** Haze starts just past the room's far corner by default... */
export const FOG_NEAR = CAMERA_DISTANCE + 14;
/** ...and has swallowed the scenery a few hundred units out. */
export const FOG_FAR = CAMERA_DISTANCE + 190;
/** Window bay width on every facade drawn by the shader. */
const BAY = 1.7;

/**
 * Darkens an environment's own surfaces at night while the office lights
 * stay on inside: the factor exterior colours are multiplied by.
 */
export const dayFactor = (look) => 0.14 + 0.86 * look.day;

// ── Exterior shader ──────────────────────────────────────────

const VERTEX_DECL = /* glsl */ `
varying vec3 vCityPos;
#ifdef CITY_WINDOWS
  attribute vec3 aTint;
  attribute float aSeed;
  varying vec3 vCityNormal;
  varying vec3 vCityTint;
  varying float vCitySeed;
#endif
`;

const VERTEX = /* glsl */ `
vec4 cityPos = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  cityPos = instanceMatrix * cityPos;
#endif
vCityPos = ( modelMatrix * cityPos ).xyz;
#ifdef CITY_WINDOWS
  vCityNormal = normal;
  vCityTint = aTint;
  vCitySeed = aSeed;
#endif
`;

const FRAGMENT_DECL = /* glsl */ `
uniform float uHaze;
uniform float uHazeDepth;
uniform float uStreetY;
varying vec3 vCityPos;
#ifdef CITY_WINDOWS
  uniform float uNight;
  uniform float uDay;
  uniform vec3 uGlass;
  uniform vec3 uGlowA;
  uniform vec3 uGlowB;
  varying vec3 vCityNormal;
  varying vec3 vCityTint;
  varying float vCitySeed;
  float cityHash( vec2 p ) {
    return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
  }
#endif
`;

// Facades: a grid of window bays per storey. Panes reflect the sky by day and
// a share of them glow at night; when a bay shrinks below a couple of pixels
// the pattern fades to its average so distant towers don't shimmer.
const WINDOWS = /* glsl */ `
float cityGlow = 0.0;
vec3 cityGlowColor = vec3( 0.0 );
#ifdef CITY_WINDOWS
{
  vec3 tint = vCityTint;
  if ( abs( vCityNormal.y ) < 0.5 ) {
    float along = abs( vCityNormal.x ) > 0.5 ? vCityPos.z : vCityPos.x;
    vec2 cell = vec2( along / ${BAY.toFixed(2)}, ( vCityPos.y - uStreetY ) / ${FLOOR_H.toFixed(2)} );
    vec2 f = fract( cell );
    vec2 aa = fwidth( cell ) * 1.5;
    float wx = smoothstep( 0.1 - aa.x, 0.1 + aa.x, f.x ) * ( 1.0 - smoothstep( 0.9 - aa.x, 0.9 + aa.x, f.x ) );
    float wy = smoothstep( 0.24 - aa.y, 0.24 + aa.y, f.y ) * ( 1.0 - smoothstep( 0.92 - aa.y, 0.92 + aa.y, f.y ) );
    float detail = clamp( 1.0 - max( aa.x, aa.y ) * 1.6, 0.0, 1.0 );
    float pane = mix( 0.55, wx * wy, detail );
    vec3 glass = mix( tint * 0.78, uGlass, 0.38 );
    diffuseColor.rgb = mix( tint, glass, pane );
    vec2 id = floor( cell );
    // A fifth to a third of the windows are lit at night, each its own brightness.
    float lit = step( 0.66 + vCitySeed * 0.14, cityHash( id + vCitySeed * 37.0 ) );
    cityGlow = pane * lit * uNight * ( 0.45 + 0.55 * cityHash( id * 0.73 + 9.2 ) );
    cityGlowColor = mix( uGlowA, uGlowB, step( 0.78, cityHash( id * 1.7 + 3.1 ) ) );
  } else {
    // Roofs: flat membrane, a shade darker than the facade.
    diffuseColor.rgb = tint * 0.74;
  }
  diffuseColor.rgb *= 0.14 + 0.86 * uDay;
}
#endif
`;

const HAZE = /* glsl */ `
#ifdef USE_FOG
  float cityDrop = clamp( -vCityPos.y / uHazeDepth, 0.0, 1.0 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, cityDrop * uHaze );
#endif
`;

/**
 * The uniforms every exterior material of one environment shares, so one
 * update re-lights all of them.
 * @param {{ haze?: number, hazeDepth?: number, streetY?: number }} [opts]
 *   haze: how much fog colour the deepest point takes on; hazeDepth: how far
 *   below the office floor that is; streetY: the window grid's ground level.
 */
export function makeExteriorUniforms({
  haze = 0.45,
  hazeDepth = 61.2,
  streetY = 0,
} = {}) {
  return {
    uHaze: { value: haze },
    uHazeDepth: { value: hazeDepth },
    uStreetY: { value: streetY },
    uNight: { value: 0 },
    uDay: { value: 1 },
    uGlass: { value: new THREE.Color('#9db4c8') },
    uGlowA: { value: new THREE.Color(1, 0.74, 0.42) },
    uGlowB: { value: new THREE.Color(0.82, 0.9, 1) },
  };
}

/**
 * @param {ReturnType<typeof makeExteriorUniforms>} uniforms Shared per environment.
 * @param {{ windows?: boolean } & THREE.MeshStandardMaterialParameters} [opts]
 *   windows: draw the facade window grid (needs the aTint / aSeed instance
 *   attributes on the geometry).
 */
export function exteriorMaterial(uniforms, { windows = false, ...params } = {}) {
  const material = new THREE.MeshStandardMaterial(params);
  if (windows) material.defines = { CITY_WINDOWS: '' };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${WINDOWS}`)
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += cityGlow * cityGlowColor * 0.85;'
      )
      .replace('#include <fog_fragment>', `#include <fog_fragment>\n${HAZE}`);
  };
  material.customProgramCacheKey = () => `wpxen-office-exterior-${windows}`;
  return material;
}

// ── Instancing ───────────────────────────────────────────────

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

/**
 * A transform for one instance: centre, size and an optional yaw. Returns a
 * shared scratch matrix — copy it (setMatrixAt does) before the next call.
 */
export function boxMatrix(x, y, z, w, h, d, yaw = 0) {
  _q.setFromEuler(_e.set(0, yaw, 0));
  return _m.compose(_p.set(x, y, z), _q, _s.set(w, h, d));
}

/** A unit box and a low-poly blob, shared by every environment's instancing. */
export const BOX = new THREE.BoxGeometry(1, 1, 1);
export const BLOB = new THREE.IcosahedronGeometry(1, 1);

/**
 * One InstancedMesh for many copies of one shape, one colour each, never
 * shadowed. `place` and `color` are read when `items` changes.
 * @template T
 * @param {ReturnType<typeof makeExteriorUniforms>} uniforms
 * @param {THREE.BufferGeometry} geometry Shared; never disposed here.
 * @param {T[]} items
 * @param {(item: T, i: number) => THREE.Matrix4} place
 * @param {(item: T, i: number) => string} color
 * @param {THREE.MeshStandardMaterialParameters} [params]
 */
export function useInstances(uniforms, geometry, items, place, color, params) {
  const material = useMemo(
    () => exteriorMaterial(uniforms, { roughness: 0.95, ...params }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uniforms]
  );
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, Math.max(items.length, 1));
    m.count = items.length;
    items.forEach((item, i) => {
      m.setMatrixAt(i, place(item, i));
      m.setColorAt(i, _c.set(color(item, i)));
    });
    m.frustumCulled = false;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, items, material]);
  // The geometry is shared; only the instance buffers are this mesh's.
  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => () => material.dispose(), [material]);
  return { mesh, material };
}

// ── Sky and haze ─────────────────────────────────────────────

/**
 * The sky behind everything and the distance fog, from the environment's look.
 * @param {{ look: object, fogNear?: number, fogFar?: number, invalidate: () => void }} props
 */
export function Atmosphere({ look, fogNear = FOG_NEAR, fogFar = FOG_FAR, invalidate }) {
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    scene.fog = new THREE.Fog('#ffffff', fogNear, fogFar);
    return () => {
      scene.fog = null;
    };
  }, [scene, fogNear, fogFar]);

  useEffect(() => {
    scene.fog?.color.set(look.fog);
    const sky = skyTexture(look);
    scene.background = sky;
    invalidate();
    return () => {
      if (scene.background === sky) scene.background = null;
      sky.dispose();
    };
  }, [scene, look, fogNear, fogFar, invalidate]);

  return null;
}

// ── Teardown ─────────────────────────────────────────────────

/**
 * Frees what a subtree put on the GPU: every geometry, material and texture
 * it draws with, and its instance buffers. OfficeScene runs it on a world
 * that is going away, which also reaches the geometry a world's module
 * shares at module scope (no component owns that). Disposing is safe for
 * anything still in use elsewhere: three uploads it again on its next draw.
 * @param {THREE.Object3D} root
 */
export function disposeTree(root) {
  const freed = new Set();
  const free = (x) => {
    if (!x || freed.has(x)) return;
    freed.add(x);
    x.dispose();
  };
  root.traverse((object) => {
    if (object.isInstancedMesh) object.dispose();
    free(object.geometry);
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) if (value?.isTexture) free(value);
      for (const uniform of Object.values(material.uniforms ?? {}))
        if (uniform?.value?.isTexture) free(uniform.value);
      free(material);
    }
  });
}

// ── Interaction ──────────────────────────────────────────────

/**
 * A world object that stands in for an agent: clicking it focuses that agent
 * (the same as clicking its character), hovering shows a pointer.
 * @param {{ pid: number, onSelect: (focus: { pid: number }) => void, children: import('react').ReactNode } & Record<string, unknown>} props
 */
export function Clickable({ pid, onSelect, children, ...props }) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!hover) return;
    document.body.style.cursor = 'pointer';
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, [hover]);
  return (
    <group
      {...props}
      onClick={(e) => {
        e.stopPropagation();
        onSelect({ pid });
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
      }}
      onPointerOut={() => setHover(false)}
    >
      {children}
    </group>
  );
}

// ── Agent events ─────────────────────────────────────────────

/**
 * The queued events of one type (and pid, when given), newest last.
 * @param {Array<{ type: string, pid: number, at: number }>} events
 * @param {string} type
 * @param {number} [pid]
 */
export function eventsFor(events, type, pid) {
  return events.filter((e) => e.type === type && (pid === undefined || e.pid === pid));
}

/** Seconds since an event happened (wall clock: events are stamped with Date.now()). */
export function eventAge(event, now = Date.now()) {
  return (now - event.at) / 1000;
}

/** Smoothstep 0..1: eases animation progress in and out. */
export function ease(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * A room's sessions, oldest first — the order sticky slots are handed out in.
 * Ended sessions linger in the snapshot for a few seconds (the engine's
 * ENDED_LINGER_MS): include them to play a departure, leave them out to count.
 * @param {{ sessions: Record<number, { pid: number, state: string, startedAt: number }> }} office
 * @param {{ ended?: boolean }} [opts]
 */
export function liveSessions(office, { ended = false } = {}) {
  return Object.values(office.sessions)
    .filter((s) => ended || s.state !== 'ended')
    .sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}
