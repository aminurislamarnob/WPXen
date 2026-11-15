import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
  BIRD_REACH,
  BLOOM_CAP,
  BUSH,
  CLOUD_HEIGHT,
  FIREFLY_DRIFT,
  HILL_SINK,
  LAWN_Y,
  flightEnd,
  flightPoint,
  planGarden,
} from '../../../../lib/office/scene/green.js';
import { hash } from '../../../../lib/office/scene/theme.js';
import { stickySlots } from '../../../../lib/office/agentEvents.js';
import {
  Atmosphere,
  BLOB,
  BOX,
  Clickable,
  boxMatrix,
  dayFactor,
  ease,
  exteriorMaterial,
  liveSessions,
  makeExteriorUniforms,
} from './common.jsx';

// ── Green view ───────────────────────────────────────────────
// The Office as a glass pavilion in a garden, lit by the local-time look: the
// room on a low stone plinth above a mown lawn, flower beds along its front,
// a pond and a stepping-stone path to its right, a fence behind it, trees and
// a forest edge behind and to its left, rolling hills in the haze beyond.
// Crowns, shrubs and flowers sway in the shader; fireflies drift at night.
//
// It reacts to the agents:
// - every live session has a bird on its own perch along the fences (a sticky
//   slot); it flies in on `arrived`, flies off once its session has ended,
//   pecks and preens while its agent is busy, sits still while it idles,
//   hops with an amber glint while it waits on you, and sits under its own
//   little rain cloud while its agent is in error;
// - every `finished` turn blooms a flower in the front beds (up to
//   BLOOM_CAP while the page is open);
// - clicking a bird focuses its agent.
//
// The layout and its view-clearance rule live in the pure lib/office/scene/
// green.js. Draw calls: about 23, every repeated part one instanced mesh.

/** How long a bird takes to fly in, and to fly off. */
const FLY_IN_MS = 2600;
const FLY_OUT_MS = 2800;
/** Birds are drawn a little larger than life so they read at office distance. */
const BIRD_SCALE = 0.95;
/** Rain streaks under each erroring bird's cloud. */
const RAIN_PER = 10;

// ── Shared shapes ────────────────────────────────────────────

const SPHERE = new THREE.SphereGeometry(1, 14, 10);
const HILL = new THREE.SphereGeometry(1, 36, 16);
const CROWN = new THREE.IcosahedronGeometry(1, 2);
const CONE = new THREE.ConeGeometry(1, 1, 8);
const TRUNK = new THREE.CylinderGeometry(0.5, 0.65, 1, 7);
const DISC = new THREE.CylinderGeometry(1, 1, 1, 20);
const BEAK = new THREE.ConeGeometry(1, 1, 6).rotateX(Math.PI / 2);
const GLINT = new THREE.OctahedronGeometry(1, 0);
/** Scale-zero: how an unused instance is parked. */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const HIT = new THREE.BoxGeometry(BIRD_REACH * 2, 1.3, BIRD_REACH * 2).translate(
  0,
  0.45,
  0
);

/** Plumage per bird, picked by pid: body, wings, head, beak. */
const SPECIES = [
  ['#e0533d', '#a8392a', '#e0533d', '#f2a23a'], // cardinal
  ['#4f80d6', '#2f5aa8', '#4f80d6', '#3a3a3a'], // bluebird
  ['#f2c230', '#33302c', '#f2c230', '#e08a2c'], // goldfinch
  ['#b9805a', '#6e4a33', '#8a6b52', '#3a3a3a'], // robin
  ['#e9e6df', '#8d9196', '#2d2f33', '#f0a03a'], // chickadee
  ['#6fae8c', '#3f7a5c', '#6fae8c', '#e8b24a'], // green finch
];

const BUILT_COLORS = {
  stone: '#ddd6c8',
  soil: '#6b4a35',
  timber: '#9a7350',
  post: '#3d3f44',
};
const CROWN_COLORS = ['#5c8f4a', '#6fa457', '#4f7f43', '#7aa860', '#62994e'];
const CONE_COLORS = ['#3f6b45', '#4c7a4f', '#45734a'];
const HILL_COLORS = ['#7fae63', '#6f9f58', '#8cb86c', '#78a85e'];
const FLOWER_COLORS = ['#f6a5c0', '#ffe38a', '#ffffff', '#c9a6ff', '#ff9e7a'];
const BLOOM_COLORS = ['#ff4f9a', '#ffd23f', '#ff8a3d', '#a865ff', '#ff5d5d', '#ffffff'];

// ── Materials ────────────────────────────────────────────────

// Wind: the top of a crown, shrub or flower drifts more than its base, each
// instance on its own phase. Inserted ahead of the kit's own vertex code.
const SWAY = /* glsl */ `
{
  vec3 swayHome = vec3( 0.0 );
  #ifdef USE_INSTANCING
    swayHome = instanceMatrix[ 3 ].xyz;
  #endif
  float swayH = clamp( position.y * 0.5 + 0.5, 0.0, 1.0 );
  float swayT = uTime * 1.1 + swayHome.x * 0.35 + swayHome.z * 0.27;
  transformed.x += sin( swayT ) * uSway * swayH;
  transformed.z += cos( swayT * 0.83 + 1.3 ) * uSway * 0.6 * swayH;
}
`;

/**
 * An exterior material whose vertices sway in the wind.
 * @param {ReturnType<typeof makeExteriorUniforms>} uniforms
 * @param {{ value: number }} time
 * @param {number} amount Local-space sway at the top of the shape.
 * @param {THREE.MeshStandardMaterialParameters} [params]
 */
function swayMaterial(uniforms, time, amount, params) {
  const material = exteriorMaterial(uniforms, { roughness: 0.92, ...params });
  const base = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    base(shader, renderer);
    shader.uniforms.uTime = time;
    shader.uniforms.uSway = { value: amount };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uTime;\nuniform float uSway;'
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SWAY}`);
  };
  material.customProgramCacheKey = () => 'wpxen-green-sway';
  return material;
}

// Fireflies drift around their home point and blink, all in the shader.
function fireflyMaterial(time) {
  const material = new THREE.MeshBasicMaterial({
    color: '#eaff8f',
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uTime;\nvarying float vBlink;'
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 home = vec3( 0.0 );
          float size = 1.0;
          #ifdef USE_INSTANCING
            home = instanceMatrix[ 3 ].xyz;
            size = length( instanceMatrix[ 0 ].xyz );
          #endif
          float t = uTime * 0.55 + home.x * 1.7 + home.z * 2.3;
          vec3 drift = vec3( sin( t ), sin( t * 1.3 + 1.0 ) * 0.6, cos( t * 0.8 ) );
          transformed += drift * ${FIREFLY_DRIFT.toFixed(2)} / max( size, 0.001 );
          vBlink = 0.25 + 0.75 * pow( 0.5 + 0.5 * sin( uTime * 2.3 + home.x * 3.1 + home.z ), 3.0 );
        }`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBlink;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.a *= vBlink;'
      );
  };
  material.customProgramCacheKey = () => 'wpxen-green-firefly';
  return material;
}

/** A mown lawn: broad light and dark stripes with a little speckle. */
function lawnTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#7ea562';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#76a05b';
  ctx.fillRect(0, 128, 256, 128);
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = r() < 0.5 ? 'rgba(52,92,44,0.16)' : 'rgba(160,196,124,0.12)';
    ctx.fillRect(r() * 256, r() * 256, 2, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// ── Instancing ───────────────────────────────────────────────

const _c = new THREE.Color();

/**
 * One InstancedMesh of `items`, drawn with `material` (owned and disposed
 * here), one colour each, never shadowed.
 */
function useMesh(geometry, material, items, place, color) {
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
  }, [geometry, material, items]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => () => material.dispose(), [material]);
  return mesh;
}

const pick = (list, seed) => list[Math.abs(Math.floor(seed)) % list.length];

// ── Garden ───────────────────────────────────────────────────

function Ground({ garden, uniforms, look, invalidate }) {
  const meadow = useMemo(
    () => exteriorMaterial(uniforms, { color: '#7c9e5f', roughness: 1 }),
    [uniforms]
  );
  const tex = useMemo(() => lawnTexture(), []);
  const lawnMat = useMemo(
    () => exteriorMaterial(uniforms, { map: tex, roughness: 0.95 }),
    [uniforms, tex]
  );
  const { lawn } = garden;
  const lw = lawn.x1 - lawn.x0;
  const ld = lawn.z1 - lawn.z0;
  useLayoutEffect(() => {
    tex.repeat.set(lw / 6, ld / 6);
  }, [tex, lw, ld]);
  useEffect(
    () => () => {
      meadow.dispose();
      lawnMat.dispose();
      tex.dispose();
    },
    [meadow, lawnMat, tex]
  );
  useLayoutEffect(() => {
    const k = dayFactor(look);
    meadow.color.set('#7c9e5f').multiplyScalar(k);
    lawnMat.color.setScalar(k);
    invalidate();
  }, [look, meadow, lawnMat, invalidate]);
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[garden.center.x, LAWN_Y - 0.02, garden.center.z]}
        material={meadow}
      >
        <circleGeometry args={[480, 64]} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[(lawn.x0 + lawn.x1) / 2, LAWN_Y, (lawn.z0 + lawn.z1) / 2]}
        material={lawnMat}
      >
        <planeGeometry args={[lw, ld]} />
      </mesh>
    </group>
  );
}

function Scenery({ garden, uniforms, time, look, invalidate }) {
  const mats = useMemo(
    () => ({
      hills: exteriorMaterial(uniforms, { roughness: 1 }),
      trunks: exteriorMaterial(uniforms, { roughness: 1 }),
      crowns: swayMaterial(uniforms, time, 0.05),
      cones: swayMaterial(uniforms, time, 0.04),
      bushes: swayMaterial(uniforms, time, 0.06),
      built: exteriorMaterial(uniforms, { roughness: 0.9 }),
      stones: exteriorMaterial(uniforms, { roughness: 0.95 }),
      lily: exteriorMaterial(uniforms, { roughness: 0.7 }),
      flowers: swayMaterial(uniforms, time, 0.12),
    }),
    [uniforms, time]
  );
  const water = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#3f7f93',
        roughness: 0.06,
        metalness: 0.3,
      }),
    []
  );
  const lamps = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#ffd89a', toneMapped: false }),
    []
  );
  const flies = useMemo(() => fireflyMaterial(time), [time]);
  // The pool of warm light each garden lamp throws on the lawn after dark.
  const pools = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#ffcf8a',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    []
  );
  useEffect(
    () => () => {
      water.dispose();
      lamps.dispose();
    },
    [water, lamps]
  );

  const round = useMemo(() => garden.trees.filter((t) => t.kind === 'round'), [garden]);
  const cones = useMemo(() => garden.trees.filter((t) => t.kind === 'cone'), [garden]);
  const stones = useMemo(
    () => [
      ...garden.pondRim.map((s) => ({ ...s, rim: true })),
      ...garden.path.map((s) => ({ ...s, rim: false })),
    ],
    [garden]
  );
  const flowerParts = useMemo(
    () =>
      garden.flowers.flatMap((f, i) => [
        { ...f, leaf: true, i },
        { ...f, leaf: false, i },
      ]),
    [garden]
  );

  const meshes = [
    useMesh(
      HILL,
      mats.hills,
      garden.hills,
      (h) => boxMatrix(h.x, LAWN_Y - h.r * h.h * HILL_SINK, h.z, h.r, h.r * h.h, h.r),
      (h, i) => pick(HILL_COLORS, i)
    ),
    useMesh(
      TRUNK,
      mats.trunks,
      garden.trees,
      (t) => {
        const girth = 0.22 + t.r * 0.07;
        return boxMatrix(
          t.x,
          LAWN_Y + t.trunk / 2 + 0.2,
          t.z,
          girth,
          t.trunk + 0.4,
          girth
        );
      },
      () => '#6b4f3a'
    ),
    useMesh(
      CROWN,
      mats.crowns,
      round,
      (t) => boxMatrix(t.x, LAWN_Y + t.trunk + t.h / 2, t.z, t.r, t.h / 2, t.r, t.x),
      (t) => pick(CROWN_COLORS, t.x * 3 + t.z)
    ),
    useMesh(
      CONE,
      mats.cones,
      cones,
      (t) => boxMatrix(t.x, LAWN_Y + t.trunk + t.h / 2, t.z, t.r, t.h, t.r),
      (t) => pick(CONE_COLORS, t.x * 5 + t.z)
    ),
    useMesh(
      CROWN,
      mats.bushes,
      garden.bushes,
      (b) =>
        boxMatrix(b.x, b.y + b.r * BUSH.lift, b.z, b.r, b.r * BUSH.squash, b.r, b.x * 2),
      (b, i) => (i % 5 === 0 ? '#6e9a52' : i % 2 ? '#5d8f4c' : '#4f8045')
    ),
    useMesh(
      BOX,
      mats.built,
      garden.built,
      (b) => boxMatrix(b.x, b.y, b.z, b.w, b.h, b.d),
      (b) => BUILT_COLORS[b.kind]
    ),
    useMesh(
      BLOB,
      mats.stones,
      stones,
      (s) =>
        s.rim
          ? boxMatrix(s.x, LAWN_Y + 0.08, s.z, s.s, s.s * 0.45, s.s)
          : boxMatrix(s.x, LAWN_Y + 0.02, s.z, s.s, 0.05, s.s * 0.8, s.yaw),
      (s, i) => (s.rim ? (i % 3 ? '#a9a59b' : '#948f85') : '#cfc8ba')
    ),
    useMesh(
      DISC,
      mats.lily,
      garden.lilyPads,
      (p) => boxMatrix(p.x, LAWN_Y + 0.09, p.z, p.s, 0.02, p.s),
      (p, i) => (i % 3 ? '#5f9a4a' : '#6fae55')
    ),
    useMesh(
      BLOB,
      mats.flowers,
      flowerParts,
      (f) =>
        f.leaf
          ? boxMatrix(f.x, f.y + 0.1, f.z, 0.24, 0.13, 0.24)
          : boxMatrix(f.x, f.y + 0.3, f.z, 0.13, 0.11, 0.13),
      (f) => (f.leaf ? '#4f8a45' : pick(FLOWER_COLORS, f.i))
    ),
    useMesh(
      BLOB,
      lamps,
      garden.lamps,
      (l) => boxMatrix(l.x, -0.38, l.z, 0.12, 0.12, 0.12),
      () => '#ffffff'
    ),
    useMesh(
      DISC,
      pools,
      garden.lamps,
      (l) => boxMatrix(l.x, LAWN_Y + 0.03, l.z, 1.3, 0.01, 1.3),
      () => '#ffffff'
    ),
    useMesh(
      BLOB,
      flies,
      garden.fireflies,
      (f) => boxMatrix(f.x, f.y, f.z, 0.07, 0.07, 0.07),
      () => '#ffffff'
    ),
  ];
  const fireflyMesh = meshes[meshes.length - 1];
  const poolMesh = meshes[meshes.length - 2];

  useLayoutEffect(() => {
    const k = dayFactor(look);
    for (const m of Object.values(mats)) m.color.setScalar(k);
    water.color.set('#3f7f93').multiplyScalar(0.35 + 0.65 * k);
    // Garden lamps: a dull glass globe by day, a warm glow after dark.
    lamps.color.set('#ffd89a').multiplyScalar(0.3 + 1.6 * look.windows);
    flies.opacity = Math.max(0, (look.windows - 0.2) / 0.8);
    pools.opacity = 0.22 * look.windows;
    poolMesh.visible = pools.opacity > 0.01;
    fireflyMesh.visible = flies.opacity > 0.01;
    invalidate();
  }, [look, mats, water, lamps, flies, pools, fireflyMesh, poolMesh, invalidate]);

  return (
    <group>
      {meshes.map((m) => (
        <primitive key={m.uuid} object={m} />
      ))}
      <mesh
        position={[garden.pond.x, LAWN_Y + 0.04, garden.pond.z]}
        scale={[garden.pond.r, 0.05, garden.pond.r]}
        geometry={DISC}
        material={water}
      />
    </group>
  );
}

// ── Blooms ───────────────────────────────────────────────────

/** A flower pops open: overshoots a little, then settles. */
function bloomScale(age) {
  if (age <= 0) return 0;
  const t = age / 0.9;
  if (t >= 1) return 1;
  return ease(t) * (1 + 0.45 * Math.sin(t * Math.PI));
}

function Blooms({ garden, events, uniforms, time, look }) {
  const material = useMemo(() => swayMaterial(uniforms, time, 0.12), [uniforms, time]);
  // A sparkle rises off each new flower and fades (shrinks) as it goes.
  const sparkleMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#fff3b0', toneMapped: false }),
    []
  );
  const sparkle = useMemo(() => {
    const m = new THREE.InstancedMesh(GLINT, sparkleMat, BLOOM_CAP);
    m.frustumCulled = false;
    m.visible = false;
    for (let i = 0; i < BLOOM_CAP; i++) m.setMatrixAt(i, HIDDEN);
    return m;
  }, [sparkleMat]);
  useEffect(() => () => sparkle.dispose(), [sparkle]);
  useEffect(() => () => sparkleMat.dispose(), [sparkleMat]);
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(BLOB, material, BLOOM_CAP * 2);
    m.count = 0;
    m.frustumCulled = false;
    for (let i = 0; i < BLOOM_CAP * 2; i++)
      m.setColorAt(
        i,
        _c.set(i % 2 === 0 ? '#4f8a45' : pick(BLOOM_COLORS, (i - 1) / 2 + 1))
      );
    return m;
  }, [material]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => () => material.dispose(), [material]);
  useLayoutEffect(() => {
    material.color.setScalar(dayFactor(look));
  }, [look, material]);

  // One bloom per finished turn, for as long as the page is open.
  const blooms = useRef([]);
  const seen = useRef(0);
  useEffect(() => {
    for (const e of events) {
      if (e.id <= seen.current) continue;
      seen.current = e.id;
      if (e.type === 'finished' && blooms.current.length < garden.bloomSpots.length)
        blooms.current.push({ spot: garden.bloomSpots[blooms.current.length], at: e.at });
    }
  }, [events, garden]);

  const drawn = useRef(-1);
  useFrame(({ clock }) => {
    const list = blooms.current;
    const now = Date.now();
    let animating = false;
    let sparkling = false;
    for (let i = 0; i < list.length; i++) {
      const age = (now - list[i].at) / 1000;
      const { x, y, z } = list[i].spot;
      if (age < 1.6 || drawn.current < list.length) {
        animating = true;
        const s = bloomScale(age);
        mesh.setMatrixAt(i * 2, boxMatrix(x, y + 0.1, z, 0.3 * s, 0.16 * s, 0.3 * s));
        mesh.setMatrixAt(
          i * 2 + 1,
          boxMatrix(x, y + 0.38 * s, z, 0.2 * s, 0.17 * s, 0.2 * s)
        );
        const k = Math.min(1, Math.max(0, (age - 0.2) / 1.4));
        if (k > 0 && k < 1) {
          sparkling = true;
          const g = 0.12 * (1 - k);
          sparkle.setMatrixAt(
            i,
            boxMatrix(x, y + 0.5 + k * 1.1, z, g, g * 1.5, g, clock.elapsedTime * 4)
          );
        } else sparkle.setMatrixAt(i, HIDDEN);
      }
    }
    if (animating) {
      mesh.count = list.length * 2;
      mesh.instanceMatrix.needsUpdate = true;
      sparkle.instanceMatrix.needsUpdate = true;
      drawn.current = list.length;
    }
    sparkle.visible = sparkling;
  });
  return (
    <group>
      <primitive object={mesh} />
      <primitive object={sparkle} />
    </group>
  );
}

// ── Birds ────────────────────────────────────────────────────

const _bird = new THREE.Matrix4();
const _part = new THREE.Matrix4();
const _out = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _pos = { x: 0, y: 0, z: 0 };
const _ahead = { x: 0, y: 0, z: 0 };

/** Places one part of a bird: local offset, rotation and size, in the bird's frame. */
function setPart(mesh, i, x, y, z, rx, ry, rz, sx, sy, sz) {
  _part.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
  mesh.setMatrixAt(i, _out.multiplyMatrices(_bird, _part));
}

function useBirdMesh(geometry, count, makeMaterial) {
  const material = useMemo(makeMaterial, []); // eslint-disable-line react-hooks/exhaustive-deps
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, count);
    m.frustumCulled = false;
    for (let i = 0; i < count; i++) {
      m.setMatrixAt(i, HIDDEN);
      m.setColorAt(i, _c.set('#ffffff'));
    }
    return m;
  }, [geometry, material, count]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => () => material.dispose(), [material]);
  return mesh;
}

const BUSY = new Set(['working', 'thinking']);

function Birds({ garden, office, events, look, onSelect }) {
  const cap = garden.perches.length;
  const feathers = () => new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const body = useBirdMesh(SPHERE, cap, feathers);
  const head = useBirdMesh(SPHERE, cap, feathers);
  const beak = useBirdMesh(BEAK, cap, feathers);
  const tail = useBirdMesh(BOX, cap, feathers);
  const wings = useBirdMesh(SPHERE, cap * 2, feathers);
  const glint = useBirdMesh(
    GLINT,
    cap,
    () => new THREE.MeshBasicMaterial({ color: '#ffb020', toneMapped: false })
  );
  const cloud = useBirdMesh(
    SPHERE,
    cap * 3,
    () => new THREE.MeshStandardMaterial({ color: '#8b939d', roughness: 1 })
  );
  const rain = useBirdMesh(
    BOX,
    cap * RAIN_PER,
    () =>
      new THREE.MeshBasicMaterial({
        color: '#a9c4e6',
        transparent: true,
        opacity: 0.75,
        toneMapped: false,
      })
  );
  // Fixed lists for the frame loop, so it never builds an array.
  const parts = useMemo(
    () => [body, head, beak, tail, wings, glint, cloud, rain],
    [body, head, beak, tail, wings, glint, cloud, rain]
  );
  const solo = useMemo(
    () => [body, head, beak, tail, glint],
    [body, head, beak, tail, glint]
  );

  // Every session in the room keeps its perch — ended ones too, while they fly off.
  const sessions = liveSessions(office, { ended: true });
  const pidKey = sessions.map((s) => s.pid).join(',');
  const slotsRef = useRef(new Map());
  const slotPid = useMemo(() => {
    slotsRef.current = stickySlots(
      slotsRef.current,
      sessions.map((s) => s.pid),
      cap
    );
    const bySlot = new Array(cap).fill(null);
    for (const [pid, slot] of slotsRef.current) bySlot[slot] = pid;
    return bySlot;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pidKey, cap]);

  // What the frame loop reads: each session's state, when it arrived, when it left.
  const live = useRef({ state: new Map(), arrivedAt: new Map(), leftAt: new Map() });
  useEffect(() => {
    const { state, arrivedAt, leftAt } = live.current;
    state.clear();
    const now = Date.now();
    for (const s of sessions) {
      state.set(s.pid, s.state);
      if (s.state === 'ended') {
        if (!leftAt.has(s.pid)) leftAt.set(s.pid, now);
      } else leftAt.delete(s.pid);
    }
    for (const pid of leftAt.keys()) if (!state.has(pid)) leftAt.delete(pid);
    for (const e of events) if (e.type === 'arrived') arrivedAt.set(e.pid, e.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [office, events]);

  // Plumage follows the pid holding each perch.
  useLayoutEffect(() => {
    slotPid.forEach((pid, i) => {
      if (pid === null) return;
      const [b, w, h, k] = pick(SPECIES, hash(String(pid)));
      body.setColorAt(i, _c.set(b));
      head.setColorAt(i, _c.set(h));
      beak.setColorAt(i, _c.set(k));
      tail.setColorAt(i, _c.set(w));
      wings.setColorAt(i * 2, _c.set(w));
      wings.setColorAt(i * 2 + 1, _c.set(w));
    });
    for (const m of [body, head, beak, tail, wings])
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [slotPid, body, head, beak, tail, wings]);

  useLayoutEffect(() => {
    const k = 0.35 + 0.65 * dayFactor(look);
    for (const m of [body, head, beak, tail, wings]) m.material.color.setScalar(k);
    cloud.material.color.set('#8b939d').multiplyScalar(0.4 + 0.6 * dayFactor(look));
  }, [look, body, head, beak, tail, wings, cloud]);

  const ends = useMemo(
    () =>
      garden.perches.map((p) => ({ in: flightEnd(p, 'in'), out: flightEnd(p, 'out') })),
    [garden]
  );
  const hits = useRef(new Map());

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const now = Date.now();
    const { state, arrivedAt, leftAt } = live.current;
    let anyBird = false;
    let anyWaiting = false;
    let anyError = false;
    for (let i = 0; i < cap; i++) {
      const pid = slotPid[i];
      const perch = garden.perches[i];
      const st = pid === null ? null : state.get(pid);
      let visible = st !== null && st !== undefined;
      let flying = false;
      let yaw = perch.yaw;
      let pos = perch;
      if (visible && leftAt.has(pid)) {
        const u = (now - leftAt.get(pid)) / FLY_OUT_MS;
        if (u >= 1) visible = false;
        else {
          const k = u * u;
          pos = flightPoint(perch, ends[i].out, k, 3, _pos);
          flightPoint(perch, ends[i].out, Math.min(1, k + 0.02), 3, _ahead);
          flying = true;
        }
      } else if (visible && arrivedAt.has(pid) && now - arrivedAt.get(pid) < FLY_IN_MS) {
        const u = (now - arrivedAt.get(pid)) / FLY_IN_MS;
        const k = 1 - (1 - u) * (1 - u);
        pos = flightPoint(ends[i].in, perch, k, 3, _pos);
        flightPoint(ends[i].in, perch, Math.min(1, k + 0.02), 3, _ahead);
        flying = u < 0.92;
      }
      const hit = pid === null ? null : hits.current.get(pid);
      if (!visible) {
        for (let m = 0; m < solo.length; m++) solo[m].setMatrixAt(i, HIDDEN);
        wings.setMatrixAt(i * 2, HIDDEN);
        wings.setMatrixAt(i * 2 + 1, HIDDEN);
        for (let k = 0; k < 3; k++) cloud.setMatrixAt(i * 3 + k, HIDDEN);
        for (let k = 0; k < RAIN_PER; k++) rain.setMatrixAt(i * RAIN_PER + k, HIDDEN);
        if (hit) hit.position.set(0, -999, 0);
        continue;
      }
      if (flying) yaw = Math.atan2(_ahead.x - pos.x, _ahead.z - pos.z);
      anyBird = true;

      const phase = i * 1.7;
      const busy = BUSY.has(st);
      const waiting = st === 'waiting_on_user';
      const error = st === 'error';
      const hop = !flying && waiting ? Math.abs(Math.sin(t * 4.5 + phase)) * 0.32 : 0;
      const peck =
        !flying && busy ? Math.pow(Math.max(0, Math.sin(t * 2.2 + phase)), 4) : 0;
      const droop = !flying && error ? 0.35 : 0;
      const breathe = 1 + 0.025 * Math.sin(t * 2 + phase);
      const flap = flying
        ? Math.sin(t * 22 + phase) * 0.9
        : waiting && hop > 0.05
          ? 0.5
          : 0;
      const by = pos.y + hop;

      _bird.compose(
        _v.set(pos.x, by, pos.z),
        _q.setFromEuler(_e.set(0, yaw, 0)),
        _s.set(BIRD_SCALE, BIRD_SCALE, BIRD_SCALE)
      );
      setPart(
        body,
        i,
        0,
        0.25 + peck * 0.03,
        0,
        -peck * 0.2,
        0,
        0,
        0.2,
        0.19 * breathe,
        0.3
      );
      const hy = 0.45 - peck * 0.14 - droop * 0.12;
      const hz = 0.2 + peck * 0.08;
      setPart(head, i, 0, hy, hz, 0, 0, 0, 0.14, 0.14, 0.14);
      setPart(
        beak,
        i,
        0,
        hy - 0.01 - peck * 0.04,
        hz + 0.15,
        peck * 0.7 + droop,
        0,
        0,
        0.045,
        0.045,
        0.11
      );
      setPart(
        tail,
        i,
        0,
        0.3,
        -0.33,
        -0.5 + (busy ? Math.sin(t * 6 + phase) * 0.15 : 0),
        0,
        0,
        0.14,
        0.03,
        0.28
      );
      setPart(wings, i * 2, 0.19, 0.3, -0.03, 0, 0, 0.15 + flap, 0.05, 0.13, 0.24);
      setPart(wings, i * 2 + 1, -0.19, 0.3, -0.03, 0, 0, -0.15 - flap, 0.05, 0.13, 0.24);

      if (waiting && !flying) {
        anyWaiting = true;
        const g = 0.11 * (1 + 0.3 * Math.sin(t * 8 + phase));
        setPart(
          glint,
          i,
          0,
          0.85 + 0.05 * Math.sin(t * 5),
          0.1,
          0,
          t * 3,
          0,
          g,
          g * 1.4,
          g
        );
      } else glint.setMatrixAt(i, HIDDEN);

      if (error && !flying) {
        anyError = true;
        // A little cloud of its own, in world space above the perch.
        _bird.compose(_v.set(pos.x, pos.y, pos.z), _q.identity(), _s.set(1, 1, 1));
        const cy = CLOUD_HEIGHT + 0.08 * Math.sin(t * 0.8 + phase);
        setPart(cloud, i * 3, -0.32, cy, 0, 0, 0, 0, 0.42, 0.3, 0.38);
        setPart(cloud, i * 3 + 1, 0.05, cy + 0.12, 0.05, 0, 0, 0, 0.5, 0.38, 0.45);
        setPart(cloud, i * 3 + 2, 0.4, cy - 0.02, -0.05, 0, 0, 0, 0.38, 0.28, 0.34);
        for (let k = 0; k < RAIN_PER; k++) {
          const fall = (t * 2.6 + k * 0.37 + phase) % 1;
          const rx = ((k * 7) % 10) / 10 - 0.45;
          const rz = ((k * 3) % 10) / 10 - 0.45;
          setPart(
            rain,
            i * RAIN_PER + k,
            rx,
            cy - 0.25 - fall * (cy - 0.45),
            rz,
            0,
            0,
            0,
            0.025,
            0.22,
            0.025
          );
        }
      } else {
        for (let k = 0; k < 3; k++) cloud.setMatrixAt(i * 3 + k, HIDDEN);
        for (let k = 0; k < RAIN_PER; k++) rain.setMatrixAt(i * RAIN_PER + k, HIDDEN);
      }
      if (hit) hit.position.set(pos.x, by, pos.z);
    }
    for (let m = 0; m < parts.length; m++) parts[m].instanceMatrix.needsUpdate = true;
    // Meshes with nothing to show cost no draw call.
    for (let m = 0; m < 5; m++) parts[m].visible = anyBird;
    glint.visible = anyWaiting;
    cloud.visible = anyError;
    rain.visible = anyError;
  });

  return (
    <group>
      {parts.map((m) => (
        <primitive key={m.uuid} object={m} />
      ))}
      {slotPid.map(
        (pid, i) =>
          pid !== null && (
            <Clickable key={pid} pid={pid} onSelect={onSelect}>
              <group
                ref={(g) => {
                  if (g) hits.current.set(pid, g);
                  else hits.current.delete(pid);
                }}
                position={[garden.perches[i].x, garden.perches[i].y, garden.perches[i].z]}
              >
                {/* Invisible, but still raycast: birds are small, the target isn't. */}
                <mesh geometry={HIT} visible={false} />
              </group>
            </Clickable>
          )
      )}
    </group>
  );
}

// ── Environment ──────────────────────────────────────────────

const seedFor = (kind) => (kind === 'antigravity' ? 8 : 5);

/** Re-render on the moment, the room, its agents and its events; plan is new every snapshot. */
const greenEqual = (a, b) =>
  a.look === b.look &&
  a.kind === b.kind &&
  a.office === b.office &&
  a.events === b.events &&
  a.onSelect === b.onSelect &&
  a.plan.minX === b.plan.minX &&
  a.plan.maxX === b.plan.maxX &&
  a.plan.minZ === b.plan.minZ &&
  a.plan.maxZ === b.plan.maxZ;

/** See ./index.js for the props every environment receives. */
export const Green = memo(function Green({ plan, kind, look, office, events, onSelect }) {
  const invalidate = useThree((s) => s.invalidate);
  const { minX, maxX, minZ, maxZ } = plan;
  const garden = useMemo(
    () => planGarden({ minX, maxX, minZ, maxZ }, { seed: seedFor(kind) }),
    [minX, maxX, minZ, maxZ, kind]
  );
  // The garden sits at ground level: no height haze, only the distance fog.
  const uniforms = useMemo(() => makeExteriorUniforms({ haze: 0 }), []);
  const time = useMemo(() => ({ value: 0 }), []);
  useFrame(({ clock }) => {
    time.value = clock.elapsedTime;
  });
  return (
    <group>
      <Atmosphere look={look} invalidate={invalidate} />
      <Ground garden={garden} uniforms={uniforms} look={look} invalidate={invalidate} />
      <Scenery
        garden={garden}
        uniforms={uniforms}
        time={time}
        look={look}
        invalidate={invalidate}
      />
      <Blooms
        garden={garden}
        events={events}
        uniforms={uniforms}
        time={time}
        look={look}
      />
      <Birds
        garden={garden}
        office={office}
        events={events}
        look={look}
        onSelect={onSelect}
      />
    </group>
  );
}, greenEqual);
