import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CAMERA_DISTANCE } from '../../../../lib/office/scene/environments.js';
import { stickySlots } from '../../../../lib/office/agentEvents.js';
import { rng } from '../../../../lib/office/scene/city.js';
import {
  SEABED_Y,
  SLAB,
  domeShape,
  insideDome,
  planSeabed,
  roomBox,
  schoolAnchor,
} from '../../../../lib/office/scene/underwater.js';
import {
  Atmosphere,
  BLOB,
  Clickable,
  dayFactor,
  ease,
  eventsFor,
  liveSessions,
} from './common.jsx';

// ── Underwater research dome ─────────────────────────────────
// The room under a glass dome on the sea floor: a steel base deck on the sand,
// rocks, coral and swaying kelp around it, light rippling down from the
// surface (caustics drawn in the shader), plankton drifting in a dense blue
// haze. Lit by environmentLook('underwater'): bright by day, deep blue at
// night with the dome's lamps on.
//
// It answers the agents: each live session has a fish school hovering
// outside the glass on the side nearer its desk — circling tight and fast
// while it works, drifting loose while idle, scattering red on an error,
// swimming in from the murk when the session arrives and away when it ends.
// An agent waiting on you sends bubbles up from its desk; a finished turn
// sends a manta ray gliding by behind the dome. Clicking a school focuses its
// agent.
//
// Layout (dome, anchors, seabed) is the pure lib/office/scene/underwater.js,
// which tests the rule every environment keeps: nothing above the floor
// between the camera and the room. The dome's glass and ribs are drawn only
// behind and beside the room — the shader discards the rest — so it reads as
// a cut-away. About 13 draw calls, plus 4 per manta while one passes.

/** Fish schools drawn at most; more sessions than this get none. */
const SCHOOLS = 12;
/** Fish per school. */
const FISH = 11;
const SCHOOL_COLORS = [
  '#ffd23f',
  '#4fb3ff',
  '#ff8c42',
  '#dfe9ef',
  '#7bd389',
  '#ff6fb5',
  '#a99bff',
  '#3ddbd9',
];
const ERROR_RED = new THREE.Color('#ff3b30');
/** How a school swims in each agent state: orbit radius, speed (rad/s), looseness, bob. */
const SWIM = {
  busy: { radius: 0.95, speed: 1.9, spread: 0.25, lift: 0.25, red: 0 },
  waiting: { radius: 1.4, speed: 0.75, spread: 0.4, lift: 0.35, red: 0 },
  idle: { radius: 2.1, speed: 0.32, spread: 0.95, lift: 0.5, red: 0 },
  error: { radius: 2.9, speed: 2.6, spread: 1.5, lift: 0.9, red: 1 },
};
const swimFor = (state) =>
  state === 'working' || state === 'thinking'
    ? SWIM.busy
    : state === 'waiting_on_user'
      ? SWIM.waiting
      : state === 'error'
        ? SWIM.error
        : SWIM.idle;
/** Haze: the room stays clear, a few tens of metres out is murk. */
const FOG_NEAR = CAMERA_DISTANCE + 12;
const FOG_FAR = CAMERA_DISTANCE + 62;
const SAND_COLOR = '#c3c4a6';
const STEEL = '#a3b5bc';
/** Camera azimuth (OfficeScene's VIEW_DIR): light shafts turn to face it. */
const FACE_CAMERA = Math.atan2(1, 1.12);
const MANTA_SECONDS = 8.5;

const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// ── Water shader ─────────────────────────────────────────────
// Injected into MeshStandardMaterial so lights, fog and instancing keep
// working. Per material, by define: kelp sway, fish tail wag, sand ripples,
// caustics on up-facing surfaces, and the dome's cut-away discard.

const VERTEX_DECL = /* glsl */ `
uniform float uTime;
varying vec3 vWaterPos;
`;

const VERTEX = /* glsl */ `
#ifdef WATER_SWAY
{
  #ifdef USE_INSTANCING
    vec3 iw = instanceMatrix[3].xyz;
    float sx = length( instanceMatrix[0].xyz );
    float sy = length( instanceMatrix[1].xyz );
    float sz = length( instanceMatrix[2].xyz );
  #else
    vec3 iw = vec3( 0.0 );
    float sx = 1.0;
    float sy = 1.0;
    float sz = 1.0;
  #endif
  float hgt = clamp( position.y, 0.0, 1.0 );
  float bend = hgt * hgt * sy * 0.11;
  float ph = iw.x * 0.37 + iw.z * 0.61;
  transformed.x += sin( uTime * 0.9 + ph + hgt * 2.4 ) * bend / max( sx, 0.001 );
  transformed.z += cos( uTime * 0.7 + ph * 1.3 + hgt * 1.9 ) * bend * 0.6 / max( sz, 0.001 );
}
#endif
#ifdef WATER_WAG
{
  #ifdef USE_INSTANCING
    float wid = float( gl_InstanceID );
  #else
    float wid = 0.0;
  #endif
  float tail = max( 0.0, -position.x - 0.25 );
  transformed.z += sin( uTime * 11.0 + wid * 1.7 ) * 0.6 * tail;
}
#endif
vec4 waterPos = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  waterPos = instanceMatrix * waterPos;
#endif
vWaterPos = ( modelMatrix * waterPos ).xyz;
`;

const FRAGMENT_DECL = /* glsl */ `
uniform float uTime;
uniform vec3 uCaustic;
uniform vec4 uRoom;
uniform vec4 uMurk;
uniform float uTint;
varying vec3 vWaterPos;
// Tileable water caustics (after joltz0r / Dave Hoskins).
float waterCaustic( vec2 uv, float t ) {
  vec2 p = mod( uv * 6.28318, 6.28318 ) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for ( int n = 0; n < 4; n++ ) {
    float tt = t * ( 1.0 - ( 3.5 / float( n + 1 ) ) );
    i = p + vec2( cos( tt - i.x ) + sin( tt + i.y ), sin( tt - i.y ) + cos( tt + i.x ) );
    c += 1.0 / length( vec2( p.x / ( sin( i.x + tt ) / inten ), p.y / ( cos( i.y + tt ) / inten ) ) );
  }
  c /= 4.0;
  c = 1.17 - pow( c, 1.4 );
  return clamp( pow( abs( c ), 8.0 ), 0.0, 1.4 );
}
`;

// The dome is a cut-away: keep only what stands behind the back wall or
// beyond the left wall (uRoom = x0, x1, z0, z1).
const CLIP = /* glsl */ `
#ifdef WATER_CLIP
{
  bool behind = vWaterPos.z < uRoom.z - 0.25 && vWaterPos.x <= uRoom.y;
  bool beside = vWaterPos.x < uRoom.x - 0.25 && vWaterPos.z <= uRoom.w;
  if ( !( behind || beside ) ) discard;
}
#endif
`;

const SAND = /* glsl */ `
#ifdef WATER_SAND
{
  vec2 p = vWaterPos.xz;
  float rip = sin( dot( p, vec2( 0.83, 0.36 ) ) * 2.3 + sin( p.y * 0.31 + p.x * 0.12 ) * 2.5 );
  diffuseColor.rgb *= 0.93 + 0.07 * rip;
}
#endif
`;

// Water swallows what is far from the dome. Depth fog alone barely moves in
// an orthographic view (everything near the room sits at one depth), so the
// murk thickens with horizontal distance from the room instead
// (uMurk = start, end, centre x, centre z).
const MURK = /* glsl */ `
#ifdef USE_FOG
{
  // uTint: the water's own colour over everything, deeper after dark.
  float murk = max( uTint, smoothstep( uMurk.x, uMurk.y, length( vWaterPos.xz - uMurk.zw ) ) );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, murk * 0.88 );
}
#endif
`;

const CAUSTICS = /* glsl */ `
#ifdef WATER_CAUSTICS
{
  vec2 uv = vWaterPos.xz * 0.13;
  float fade = clamp( 1.0 - length( fwidth( uv ) ) * 7.0, 0.0, 1.0 );
  vec3 up = inverseTransformDirection( normal, viewMatrix );
  float c = waterCaustic( uv, uTime * 0.42 );
  totalEmissiveRadiance += uCaustic * c * fade * clamp( up.y, 0.0, 1.0 );
}
#endif
`;

/**
 * @param {Record<string, { value: unknown }>} uniforms Shared: uTime, uCaustic, uRoom.
 * @param {{ sway?: boolean, wag?: boolean, sand?: boolean, caustics?: boolean, clip?: boolean }} flags
 * @param {THREE.MeshStandardMaterialParameters} [params]
 */
function waterMaterial(uniforms, flags, params) {
  const material = new THREE.MeshStandardMaterial(params);
  const defines = {};
  if (flags.sway) defines.WATER_SWAY = '';
  if (flags.wag) defines.WATER_WAG = '';
  if (flags.sand) defines.WATER_SAND = '';
  if (flags.caustics) defines.WATER_CAUSTICS = '';
  if (flags.clip) defines.WATER_CLIP = '';
  material.defines = defines;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n${CLIP}`
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${SAND}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n${CAUSTICS}`
      )
      .replace('#include <fog_fragment>', `#include <fog_fragment>\n${MURK}`);
  };
  const key = Object.keys(defines).sort().join('-');
  material.customProgramCacheKey = () => `wpxen-underwater-${key}`;
  return material;
}

// ── Shapes ───────────────────────────────────────────────────

/** A low-poly fish facing +x: an ellipsoid body and a fanned tail. */
const FISH_GEOMETRY = (() => {
  const body = new THREE.SphereGeometry(0.5, 8, 6);
  body.scale(1, 0.48, 0.22);
  const tail = new THREE.ConeGeometry(0.26, 0.42, 4);
  tail.rotateZ(-Math.PI / 2);
  tail.translate(-0.66, 0, 0);
  tail.scale(1, 1.15, 0.25);
  return mergeGeometries([body, tail]);
})();
/** A kelp blade, base at y = 0, ten bends tall. */
const BLADE = new THREE.BoxGeometry(1, 1, 0.12, 1, 10, 1).translate(0, 0.5, 0);
/** A coral branch: a tapering stalk, base at y = 0. */
const BRANCH = new THREE.CylinderGeometry(0.35, 1, 1, 6).translate(0, 0.5, 0);
/** A porthole on the pedestal: a lit disc facing out along +z. */
const LAMP = new THREE.CylinderGeometry(0.5, 0.5, 1, 16).rotateX(Math.PI / 2);
/** A light shaft: a plane standing on its base. */
const SHAFT = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function place(x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  _q.setFromEuler(_e.set(rx, ry, rz));
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** A static InstancedMesh: one matrix and colour per item, disposed with its items. */
function useStatic(geometry, material, items, matrix, color) {
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, Math.max(items.length, 1));
    m.count = items.length;
    items.forEach((item, i) => {
      m.setMatrixAt(i, matrix(item, i));
      m.setColorAt(i, _c.set(color(item, i)));
    });
    m.frustumCulled = false;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, material, items]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  return mesh;
}

// ── The dome and its base ────────────────────────────────────

function domeRibs(dome) {
  const point = (theta, phi) =>
    new THREE.Vector3(
      dome.cx + dome.a * Math.cos(theta) * Math.cos(phi),
      dome.baseY + dome.b * Math.sin(theta),
      dome.cz + dome.c * Math.cos(theta) * Math.sin(phi)
    );
  const parts = [];
  for (let m = 0; m < 18; m++) {
    const phi = (m / 18) * Math.PI * 2;
    const pts = [];
    for (let k = 0; k <= 24; k++) pts.push(point((k / 24) * (Math.PI / 2), phi));
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.07, 5));
  }
  for (const [theta, r] of [
    [0.01, 0.22],
    [0.3, 0.06],
    [0.62, 0.06],
    [0.95, 0.06],
  ]) {
    const pts = [];
    for (let k = 0; k < 96; k++) pts.push(point(theta, (k / 96) * Math.PI * 2));
    parts.push(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 192, r, 5, true)
    );
  }
  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return merged;
}

function Dome({ dome, materials }) {
  const ribs = useMemo(() => domeRibs(dome), [dome]);
  useEffect(() => () => ribs.dispose(), [ribs]);
  return (
    <group>
      <mesh
        position={[dome.cx, dome.baseY, dome.cz]}
        scale={[dome.a, dome.b, dome.c]}
        material={materials.glass}
        renderOrder={2}
      >
        <sphereGeometry args={[1, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      <mesh geometry={ribs} material={materials.rib} />
    </group>
  );
}

/** The steel pedestal the room stands on, from its floor slab down to the sand, with a band of lamps. */
function Base({ room, materials }) {
  const x0 = room.x0 - 0.3;
  const x1 = room.x1 + 0.3;
  const z0 = room.z0 - 0.3;
  const z1 = room.z1 + 0.3;
  const top = -SLAB;
  const bottom = SEABED_Y - 0.2;
  const lamps = useMemo(() => {
    const out = [];
    // Only the two faces the camera sees carry lamps.
    for (let x = x0 + 1.4; x < x1 - 0.8; x += 2.6) out.push({ x, z: z1 + 0.02, yaw: 0 });
    for (let z = z0 + 1.4; z < z1 - 0.8; z += 2.6)
      out.push({ x: x1 + 0.02, z, yaw: Math.PI / 2 });
    return out;
  }, [x0, x1, z0, z1]);
  const lampMesh = useStatic(
    LAMP,
    materials.lamp,
    lamps,
    (l) => place(l.x, top - 1.05, l.z, 0.42, 0.42, 0.06, 0, l.yaw),
    () => '#ffffff'
  );
  return (
    <group>
      <mesh
        position={[(x0 + x1) / 2, (top + bottom) / 2, (z0 + z1) / 2]}
        material={materials.base}
      >
        <boxGeometry args={[x1 - x0, top - bottom, z1 - z0]} />
      </mesh>
      {/* a darker plinth course where the pedestal meets the sand */}
      <mesh
        position={[(x0 + x1) / 2, bottom + 0.35, (z0 + z1) / 2]}
        material={materials.rib}
      >
        <boxGeometry args={[x1 - x0 + 0.5, 0.7, z1 - z0 + 0.5]} />
      </mesh>
      <primitive object={lampMesh} />
    </group>
  );
}

// ── Seabed ───────────────────────────────────────────────────

function Seabed({ seabed, dome, materials }) {
  const rocks = useStatic(
    BLOB,
    materials.rock,
    seabed.rocks,
    (r) => place(r.x, SEABED_Y, r.z, r.s, r.h, r.s * 0.8, 0, r.yaw),
    (r, i) => (i % 3 ? '#727a7c' : '#5f6a6e')
  );
  const branches = useMemo(
    () => seabed.corals.filter((c) => c.kind === 'branch'),
    [seabed]
  );
  const blobs = useMemo(() => seabed.corals.filter((c) => c.kind === 'blob'), [seabed]);
  const branchMesh = useStatic(
    BRANCH,
    materials.coral,
    branches,
    (c) =>
      place(c.x, SEABED_Y, c.z, c.s * 0.5, c.h, c.s * 0.5, c.tilt, c.yaw, c.tilt * 0.6),
    (c) => c.color
  );
  const blobMesh = useStatic(
    BLOB,
    materials.coral,
    blobs,
    (c) => place(c.x, SEABED_Y, c.z, c.s * 1.5, c.h * 0.45, c.s * 1.5, 0, c.yaw),
    (c) => c.color
  );
  const kelpMesh = useStatic(
    BLADE,
    materials.kelp,
    seabed.kelp,
    (k) => place(k.x, SEABED_Y, k.z, k.w, k.h, k.w, 0, k.yaw),
    (k) => k.color
  );
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[dome.cx, SEABED_Y, dome.cz]}
        material={materials.sand}
      >
        <circleGeometry args={[320, 72]} />
      </mesh>
      <primitive object={rocks} />
      <primitive object={branchMesh} />
      <primitive object={blobMesh} />
      <primitive object={kelpMesh} />
    </group>
  );
}

/** Sunlight slanting down through the water, behind and beside the dome. */
function Shafts({ room, material }) {
  const shafts = useMemo(() => {
    const rand = rng(17);
    return Array.from({ length: 7 }, (_, i) => {
      const behind = i % 2 === 0;
      return {
        x: behind ? room.x0 - 8 + rand() * (room.w - 2) : room.x0 - 10 - rand() * 18,
        z: behind ? room.z0 - 12 - rand() * 16 : room.z0 + rand() * room.d * 0.8,
        w: 2.5 + rand() * 4,
        lean: (rand() - 0.5) * 0.3,
      };
    });
  }, [room]);
  const mesh = useStatic(
    SHAFT,
    material,
    shafts,
    (s) => place(s.x, SEABED_Y, s.z, s.w, 42, 1, 0, FACE_CAMERA, s.lean),
    () => '#ffffff'
  );
  return <primitive object={mesh} />;
}

/** Plankton drifting up through the haze, only where it can't speck the room. */
function Plankton({ room, dome, uniforms }) {
  const points = useMemo(() => {
    const rand = rng(23);
    const pos = [];
    const band = [];
    const seed = [];
    const regions = [
      // [x0, x1, z0, z1, top]: behind and beside may rise, the rest stays low.
      [room.x0 - 45, room.x1, room.z0 - 45, room.z0 - 1.5, 11],
      [room.x0 - 45, room.x0 - 1.5, room.z0, room.z1, 11],
      [room.x0 - 30, room.x1 + 40, room.z1 + 1, room.z1 + 40, -0.6],
      [room.x1 + 1, room.x1 + 40, room.z0 - 40, room.z1, -0.6],
    ];
    for (let i = 0; i < 640; i++) {
      const [x0, x1, z0, z1, top] = regions[i % regions.length];
      const x = x0 + rand() * (x1 - x0);
      const z = z0 + rand() * (z1 - z0);
      const y = SEABED_Y + rand() * (top - SEABED_Y);
      if (insideDome(dome, x, y, z)) continue;
      pos.push(x, y, z);
      band.push(SEABED_Y, top - SEABED_Y);
      seed.push(rand());
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aBand', new THREE.Float32BufferAttribute(band, 2));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    return g;
  }, [room, dome]);
  const material = useMemo(() => {
    const m = new THREE.PointsMaterial({
      color: '#d8f4ff',
      size: 2.2,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nattribute vec2 aBand;\nattribute float aSeed;'
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          transformed.y = aBand.x + mod( position.y - aBand.x + uTime * ( 0.06 + aSeed * 0.1 ), aBand.y );
          transformed.x += sin( uTime * 0.3 + aSeed * 40.0 ) * 0.5;
          transformed.z += cos( uTime * 0.23 + aSeed * 27.0 ) * 0.5;`
        );
    };
    m.customProgramCacheKey = () => 'wpxen-underwater-plankton';
    return m;
  }, [uniforms]);
  useEffect(() => () => points.dispose(), [points]);
  useEffect(() => () => material.dispose(), [material]);
  return <points geometry={points} material={material} frustumCulled={false} />;
}

// ── Reactions ────────────────────────────────────────────────

/** One fish school per agent, plus an invisible, clickable volume around each. */
function Schools({ office, desks, dome, room, events, onSelect, material }) {
  const slots = useRef(new Map());
  const schools = useMemo(() => {
    const sessions = liveSessions(office, { ended: true });
    slots.current = stickySlots(
      slots.current,
      sessions.map((s) => s.pid),
      SCHOOLS
    );
    return sessions
      .filter((s) => slots.current.has(s.pid))
      .map((s) => {
        const slot = slots.current.get(s.pid);
        const desk = desks.get(s.pid) ?? { x: room.cx, z: room.cz };
        return {
          pid: s.pid,
          slot,
          state: s.state,
          anchor: schoolAnchor(dome, room, desk, slot),
          color: new THREE.Color(SCHOOL_COLORS[slot % SCHOOL_COLORS.length]),
          arrivedAt: eventsFor(events, 'arrived', s.pid).at(-1)?.at ?? 0,
        };
      });
  }, [office, desks, dome, room, events]);

  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(FISH_GEOMETRY, material, SCHOOLS * FISH);
    for (let i = 0; i < SCHOOLS * FISH; i++) {
      m.setMatrixAt(i, ZERO);
      m.setColorAt(i, _c.set('#ffffff'));
    }
    m.frustumCulled = false;
    return m;
  }, [material]);
  useEffect(() => () => mesh.dispose(), [mesh]);

  const live = useRef(schools);
  live.current = schools;
  const swim = useRef(new Map());
  const hits = useRef(new Map());
  const drawn = useRef(new Set());
  // Two sets swapped every frame, so tracking which slots are drawn allocates nothing.
  const spare = useRef(new Set());

  useFrame((_, dt) => {
    const now = Date.now();
    const k = 1 - Math.exp(-Math.min(dt, 0.2) * 1.6);
    const used = spare.current;
    used.clear();
    let recolor = false;
    for (const sc of live.current) {
      used.add(sc.slot);
      const want = swimFor(sc.state);
      let st = swim.current.get(sc.pid);
      if (!st) {
        st = { ...want, phase: hash(sc.pid) * 10, leftAt: 0, tint: -1 };
        swim.current.set(sc.pid, st);
      }
      st.radius += (want.radius - st.radius) * k;
      st.speed += (want.speed - st.speed) * k;
      st.spread += (want.spread - st.spread) * k;
      st.lift += (want.lift - st.lift) * k;
      st.red += (want.red - st.red) * k;
      st.phase += st.speed * Math.min(dt, 0.2);
      if (sc.state === 'ended') st.leftAt ||= now;
      else st.leftAt = 0;

      // Swimming in from the murk, or away into it.
      const arriving = sc.arrivedAt ? 1 - ease((now - sc.arrivedAt) / 3500) : 0;
      const leaving = st.leftAt ? ease((now - st.leftAt) / 3200) : 0;
      const away = Math.max(arriving, leaving);
      const { anchor } = sc;
      const [ox, oz] = anchor.out;
      const [ax, az] = anchor.along;
      const cx = anchor.x + ox * 30 * away;
      const cy = anchor.y - 3 * away;
      const cz = anchor.z + oz * 30 * away;
      const shrink = st.leftAt ? 1 - ease((now - st.leftAt - 2200) / 1400) : 1;

      const tintChanged = Math.abs(st.tint - st.red) > 0.01;
      if (tintChanged) {
        st.tint = st.red;
        recolor = true;
      }
      for (let i = 0; i < FISH; i++) {
        const h1 = hash(sc.slot * 31 + i);
        const h2 = hash(sc.slot * 17 + i * 7 + 3);
        const ang = st.phase * (0.85 + 0.3 * h1) + (i / FISH) * Math.PI * 2;
        const rr = st.radius * (1 + st.spread * (h1 - 0.5));
        const along = Math.cos(ang) * rr * 1.35;
        const across = Math.sin(ang) * rr * 0.5;
        let x = cx + along * ax + across * ox;
        let z = cz + along * az + across * oz;
        const y = cy + Math.sin(ang * 1.3 + i) * st.lift + (h2 - 0.5) * st.spread * 0.9;
        // Never drift past the walls' planes toward the camera's side.
        if (anchor.side === 'back') {
          z = Math.min(z, room.z0 - 0.6);
          x = Math.min(x, room.x1 - 0.3);
        } else {
          x = Math.min(x, room.x0 - 0.6);
          z = Math.min(z, room.z1 - 0.3);
        }
        let dx = -Math.sin(ang) * 1.35 * ax + Math.cos(ang) * 0.5 * ox;
        let dz = -Math.sin(ang) * 1.35 * az + Math.cos(ang) * 0.5 * oz;
        if (away > 0.05) {
          // Heading in (toward the dome) or out (away from it).
          const sign = leaving > arriving ? 1 : -1;
          dx = dx * (1 - away) + ox * sign * away;
          dz = dz * (1 - away) + oz * sign * away;
        }
        const s = 0.34 * (0.85 + 0.3 * h2) * shrink;
        const index = sc.slot * FISH + i;
        mesh.setMatrixAt(index, place(x, y, z, s, s, s, 0, Math.atan2(-dz, dx)));
        if (tintChanged) {
          _c.copy(sc.color)
            .offsetHSL(0, 0, (h2 - 0.5) * 0.12)
            .lerp(ERROR_RED, st.red);
          mesh.setColorAt(index, _c);
        }
      }
      const hit = hits.current.get(sc.pid);
      if (hit) {
        hit.position.set(cx, cy, cz);
        hit.scale.setScalar(st.radius * 1.4 + 0.9);
      }
    }
    // Schools that left give their fish back.
    for (const slot of drawn.current)
      if (!used.has(slot))
        for (let i = 0; i < FISH; i++) mesh.setMatrixAt(slot * FISH + i, ZERO);
    spare.current = drawn.current;
    drawn.current = used;
    for (const pid of swim.current.keys())
      if (!live.current.some((sc) => sc.pid === pid)) swim.current.delete(pid);
    mesh.instanceMatrix.needsUpdate = true;
    if (recolor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      <primitive object={mesh} />
      {schools
        .filter((sc) => sc.state !== 'ended')
        .map((sc) => (
          <Clickable key={sc.pid} pid={sc.pid} onSelect={onSelect}>
            <mesh
              ref={(m) => {
                if (m) hits.current.set(sc.pid, m);
                else hits.current.delete(sc.pid);
              }}
              position={[sc.anchor.x, sc.anchor.y, sc.anchor.z]}
            >
              <sphereGeometry args={[1, 10, 8]} />
              <meshBasicMaterial visible={false} />
            </mesh>
          </Clickable>
        ))}
    </group>
  );
}

/** Bubbles: up from the desk of every agent waiting on you, and from vents in the sand. */
function Bubbles({ office, desks, vents, material }) {
  const PER_DESK = 12;
  const PER_VENT = 7;
  const MAX_DESKS = 8;
  const streams = useMemo(() => {
    const waiting = Object.values(office.sessions)
      .filter((s) => s.state === 'waiting_on_user' && desks.has(s.pid))
      .slice(0, MAX_DESKS)
      .map((s) => {
        const d = desks.get(s.pid);
        // Tall enough to clear the agent's own tag, which sits right above its head.
        return {
          x: d.x + 0.2,
          z: d.z + 0.1,
          y0: 1.2,
          h: 4.2,
          speed: 0.9,
          size: 0.1,
          count: PER_DESK,
        };
      });
    const fromVents = vents.map((v) => ({
      x: v.x,
      z: v.z,
      y0: SEABED_Y + 0.15,
      h: Math.max(0.5, v.top - SEABED_Y - 0.15),
      speed: 1.1,
      size: 0.11,
      count: PER_VENT,
    }));
    return [...waiting, ...fromVents];
  }, [office, desks, vents]);
  const capacity = MAX_DESKS * PER_DESK + vents.length * PER_VENT;
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(BLOB, material, Math.max(capacity, 1));
    m.frustumCulled = false;
    return m;
  }, [material, capacity]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  const live = useRef(streams);
  live.current = streams;

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    let n = 0;
    for (const s of live.current)
      for (let j = 0; j < s.count; j++) {
        const h = hash(n * 3.1 + s.x);
        const u = (t * s.speed * (0.8 + 0.4 * h)) / s.h + j / s.count + h;
        const f = u - Math.floor(u);
        const wob = Math.sin(t * 2.2 + j * 1.9) * 0.05 * (1 + f * 2);
        const size = s.size * (0.6 + 0.8 * h) * (0.7 + f * 0.6) * (f > 0.94 ? 0 : 1);
        mesh.setMatrixAt(
          n++,
          place(s.x + wob, s.y0 + f * s.h, s.z + wob * 0.6, size, size, size)
        );
      }
    for (let i = n; i < mesh.count; i++) mesh.setMatrixAt(i, ZERO);
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

const MANTA_BODY = new THREE.SphereGeometry(1, 10, 6).scale(0.9, 0.16, 0.5);
const MANTA_WING = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0.55, 0, 0, -0.45, 0, 0, -0.15, 0, 1.6], 3)
  );
  g.computeVertexNormals();
  return g;
})();
const MANTA_TAIL = new THREE.CylinderGeometry(0.015, 0.04, 1.4, 4)
  .rotateZ(Math.PI / 2)
  .translate(-1.4, 0, 0);

/** A manta ray gliding past behind the dome: one per finished turn, a few seconds long. */
function Manta({ at, lane, room, material }) {
  const group = useRef(null);
  const left = useRef(null);
  const right = useRef(null);
  // Parallel to the back wall, just outside the glass and low enough to stay in
  // the strip of water the room's framing shows above the wall.
  const from = useMemo(
    () => new THREE.Vector3(room.x0 - 6, 2.4 + lane * 0.9, room.z0 - 6.8 - lane * 1.6),
    [room, lane]
  );
  const to = useMemo(
    () => new THREE.Vector3(room.x1 - 3, 3.2 + lane * 0.9, room.z0 - 7.6 - lane * 1.6),
    [room, lane]
  );
  const yaw = Math.atan2(-(to.z - from.z), to.x - from.x);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const age = (Date.now() - at) / 1000;
    const u = age / MANTA_SECONDS;
    g.visible = u >= 0 && u <= 1;
    if (!g.visible) return;
    g.position.lerpVectors(from, to, u);
    g.position.y += Math.sin(age * 0.9) * 0.4;
    g.scale.setScalar(2.1 * Math.min(ease(u * 6), ease((1 - u) * 6)));
    const flap = Math.sin(age * 2.6) * 0.38;
    left.current.rotation.x = -flap;
    right.current.rotation.x = flap;
  });
  return (
    <group ref={group} rotation={[0, yaw, 0]} visible={false}>
      <mesh geometry={MANTA_BODY} material={material} />
      <mesh geometry={MANTA_TAIL} material={material} />
      <group ref={left}>
        <mesh geometry={MANTA_WING} material={material} />
      </group>
      <group ref={right} scale={[1, 1, -1]}>
        <mesh geometry={MANTA_WING} material={material} />
      </group>
    </group>
  );
}

// ── Environment ──────────────────────────────────────────────

/** See ./index.js for the props every environment receives. */
export const Underwater = memo(function Underwater({
  plan,
  kind,
  look,
  office,
  events,
  onSelect,
}) {
  const invalidate = useThree((s) => s.invalidate);
  const { minX, maxX, minZ, maxZ } = plan;
  const room = useMemo(
    () => roomBox({ minX, maxX, minZ, maxZ }),
    [minX, maxX, minZ, maxZ]
  );
  const dome = useMemo(() => domeShape(room), [room]);
  const seabed = useMemo(
    () => planSeabed(room, dome, { seed: kind === 'antigravity' ? 13 : 5 }),
    [room, dome, kind]
  );

  // Where each agent's desk is: schools hover on its side, bubbles rise from it.
  const deskKey = plan.pods
    .flatMap((p) =>
      p.desks.filter((d) => d.session).map((d) => `${d.session.pid}:${d.x}:${d.z}`)
    )
    .join('|');
  const desks = useMemo(
    () =>
      new Map(
        plan.pods.flatMap((p) =>
          p.desks.filter((d) => d.session).map((d) => [d.session.pid, { x: d.x, z: d.z }])
        )
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deskKey]
  );

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uCaustic: { value: new THREE.Color('#c8f4ff') },
      uRoom: { value: new THREE.Vector4() },
      uMurk: { value: new THREE.Vector4() },
      uTint: { value: 0.12 },
    }),
    []
  );
  useLayoutEffect(() => {
    uniforms.uRoom.value.set(room.x0, room.x1, room.z0, room.z1);
    const reach = Math.max(room.w, room.d) / 2;
    uniforms.uMurk.value.set(reach + 5, reach + 48, room.cx, room.cz);
  }, [room, uniforms]);

  const materials = useMemo(() => {
    const shaftAlpha = (() => {
      const w = 16;
      const h = 64;
      const data = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const v = y / (h - 1);
          const a =
            Math.sin((Math.PI * (x + 0.5)) / w) * Math.min(1, v * 1.6) * (1 - v * 0.35);
          data.set([255, 255, 255, Math.round(255 * a)], (y * w + x) * 4);
          // alphaMap reads the green channel.
          data[(y * w + x) * 4 + 1] = Math.round(255 * a);
        }
      const t = new THREE.DataTexture(data, w, h);
      t.needsUpdate = true;
      return t;
    })();
    return {
      sand: waterMaterial(
        uniforms,
        { sand: true, caustics: true },
        { color: SAND_COLOR, roughness: 1 }
      ),
      base: waterMaterial(
        uniforms,
        { caustics: true },
        { color: STEEL, roughness: 0.7, metalness: 0.1 }
      ),
      lamp: new THREE.MeshStandardMaterial({
        color: '#20313a',
        emissive: '#ffd9a0',
        emissiveIntensity: 1.5,
      }),
      rock: waterMaterial(uniforms, { caustics: true }, { roughness: 0.95 }),
      coral: waterMaterial(uniforms, { caustics: true }, { roughness: 0.8 }),
      kelp: waterMaterial(
        uniforms,
        { sway: true },
        { roughness: 0.7, side: THREE.DoubleSide }
      ),
      glass: waterMaterial(
        uniforms,
        { clip: true },
        {
          color: '#9ed4ee',
          transparent: true,
          opacity: 0.07,
          roughness: 0.1,
          metalness: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
        }
      ),
      rib: waterMaterial(
        uniforms,
        { clip: true },
        { color: '#7f939c', roughness: 0.45, metalness: 0.35 }
      ),
      fish: waterMaterial(uniforms, { wag: true }, { roughness: 0.45, metalness: 0.2 }),
      bubble: new THREE.MeshStandardMaterial({
        color: '#a8e6ff',
        emissive: '#4cc8ff',
        emissiveIntensity: 0.55,
        transparent: true,
        opacity: 0.8,
        roughness: 0.1,
      }),
      manta: new THREE.MeshStandardMaterial({
        color: '#2f4150',
        roughness: 0.7,
        side: THREE.DoubleSide,
      }),
      shaft: new THREE.MeshBasicMaterial({
        color: '#d6f3ff',
        alphaMap: shaftAlpha,
        transparent: true,
        opacity: 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    };
  }, [uniforms]);
  useEffect(
    () => () => {
      for (const m of Object.values(materials)) {
        m.alphaMap?.dispose();
        m.dispose();
      }
    },
    [materials]
  );

  // Daylight from the surface: brighter sand and caustics by day, lamps at night.
  useLayoutEffect(() => {
    const sun = Math.min(1, Math.max(0, (look.day - 0.25) / 0.55));
    const k = dayFactor(look);
    // Sand reads blue-grey once the sun is gone: the water, not the sand, gives the colour.
    materials.sand.color
      .set(SAND_COLOR)
      .lerp(_c.set('#6d8c9b'), 1 - sun)
      .multiplyScalar(0.25 + 0.8 * k);
    uniforms.uTint.value = 0.1 + 0.32 * (1 - sun);
    materials.base.color.set(STEEL).multiplyScalar(0.5 + 0.6 * k);
    for (const m of [materials.rock, materials.coral, materials.kelp])
      m.color.setScalar(0.35 + 0.8 * k);
    materials.lamp.emissiveIntensity = 0.5 + 2.2 * look.windows;
    materials.shaft.opacity = 0.025 + 0.11 * sun;
    uniforms.uCaustic.value.set('#c8f4ff').multiplyScalar(0.04 + 0.32 * sun);
    invalidate();
  }, [look, materials, uniforms, invalidate]);

  useFrame(({ clock }) => {
    uniforms.uTime.value = clock.elapsedTime;
  });

  const finished = eventsFor(events, 'finished').slice(-2);

  return (
    <group>
      <Atmosphere
        look={look}
        fogNear={FOG_NEAR}
        fogFar={FOG_FAR}
        invalidate={invalidate}
      />
      <Base room={room} materials={materials} />
      <Seabed seabed={seabed} dome={dome} materials={materials} />
      <Dome dome={dome} materials={materials} />
      <Shafts room={room} material={materials.shaft} />
      <Plankton room={room} dome={dome} uniforms={uniforms} />
      <Schools
        office={office}
        desks={desks}
        dome={dome}
        room={room}
        events={events}
        onSelect={onSelect}
        material={materials.fish}
      />
      <Bubbles
        office={office}
        desks={desks}
        vents={seabed.vents}
        material={materials.bubble}
      />
      {finished.map((e, i) => (
        <Manta key={e.id} at={e.at} lane={i} room={room} material={materials.manta} />
      ))}
    </group>
  );
});
