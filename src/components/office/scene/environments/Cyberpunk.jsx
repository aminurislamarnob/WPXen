import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STREET_Y, TINTS, mayRise, planCity } from '../../../../lib/office/scene/city.js';
import { stickySlots } from '../../../../lib/office/agentEvents.js';
import {
  DECK_DEPTH,
  NEON_WAITING,
  SIGN_H,
  SIGN_W,
  deckPieces,
  dockSlots,
  lightningDark,
  lightningFlash,
  neonFor,
  rainDrops,
  roomBox,
  signSlots,
  trafficLanes,
} from '../../../../lib/office/scene/cyberpunk.js';
import { stateColor } from '../../../../lib/office/scene/theme.js';
import {
  Atmosphere,
  BLOB,
  BOX,
  Clickable,
  FOG_NEAR,
  boxMatrix,
  ease,
  exteriorMaterial,
  liveSessions,
  makeExteriorUniforms,
  useInstances,
} from './common.jsx';

// ── Neon rooftop ─────────────────────────────────────────────
// The room as the rooftop office of a tower in a rain-soaked neon city, always
// at night (environmentLook('cyberpunk')). Around it: the city of
// lib/office/scene/city.js with magenta and cyan windows, wet streets far below
// with neon kerbs, flying-car traffic, rain, and an L-shaped sky-dock terrace
// behind and left of the room. The layout — signs, docks, lanes, rain — comes
// from the pure lib/office/scene/cyberpunk.js, which pins the camera rule.
//
// How it answers the agents:
// - each project lights its own neon sign on top of the back (then left) wall:
//   bright while one of its agents is busy, dim when idle, pulsing amber while
//   one waits on you, flickering bright on a finished turn; clicking it focuses
//   the project's first live agent;
// - each agent has a flying car at its own dock: it flies in on arrival,
//   lifts off and leaves when the session ends; clicking it focuses the agent;
//   the dock's pad glows in the agent's state colour;
// - an error strikes lightning: the sky and the room flash, then the city's
//   lights stutter dark for a moment.
//
// Perf: rain and traffic move in the vertex shader on instanced meshes (a time
// uniform, no CPU per-vertex work); cars, pads and sign hardware are one
// instanced mesh each; only the sign faces (one texture per project) and two
// holo billboards are separate draws. Nothing out here is in the shadow map.

const seedFor = (kind) => (kind === 'antigravity' ? 23 : 17);
/** Fog: denser than the city's — rain and smog. */
const FOG_FAR = FOG_NEAR + 165;
/** Seconds a car takes to fly in, and to lift off and leave (sessions linger 4 s once ended). */
const ARRIVE_S = 3.2;
const LEAVE_S = 3.2;
/** How long a finished turn makes its project's sign flicker. */
const FLICKER_S = 1.6;
/** Hover height of a docked car above the terrace. */
const PARK_Y = 0.62;

const MAGENTA = new THREE.Color('#ff4fd2');
const CYAN = new THREE.Color('#3fe6ff');
/** Window light: softer than the neon, so a tower reads as offices, not a sign. */
const WINDOW_A = new THREE.Color('#e0609f').multiplyScalar(0.62);
const WINDOW_B = new THREE.Color('#58cfee').multiplyScalar(0.55);
const WHITE = new THREE.Color('#ffffff');
const FLASH = new THREE.Color('#dfe6ff');

// Scratch objects for the per-frame work: nothing in useFrame allocates.
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// ── Shader-driven motion (rain, traffic) ─────────────────────

/**
 * Rain: each instance is a streak placed at its column (translation-only
 * instance matrix); the shader drops it from aDrop.x through aDrop.y units,
 * offset by its phase, at its speed.
 */
function rainMaterial(uniforms) {
  const material = new THREE.MeshBasicMaterial({
    color: '#bfb0ff',
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 aDrop;\nuniform float uTime;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed.y += aDrop.x - mod( aDrop.z + uTime * aDrop.w, aDrop.y );'
      );
  };
  material.customProgramCacheKey = () => 'wpxen-neon-rain';
  return material;
}

/**
 * Traffic: each instance sits at its lane's centre, turned to the lane's
 * heading; the shader slides it along local x (aLane: length, speed, phase),
 * mirrors it for the opposite direction, and shrinks it to nothing at the
 * lane's ends so cars never pop in or out.
 */
function trafficMaterial(uniforms, params) {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, ...params });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 aLane;\nuniform float uTime;'
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
float laneT = mod( aLane.z + uTime * aLane.y, aLane.x );
transformed *= smoothstep( 0.0, 8.0, laneT ) * smoothstep( aLane.x, aLane.x - 8.0, laneT );
transformed.x *= sign( aLane.y );
transformed.x += laneT - aLane.x * 0.5;`
      );
  };
  material.customProgramCacheKey = () =>
    `wpxen-neon-traffic-${params.vertexColors ? 'l' : 'b'}`;
  return material;
}

/** Paints one geometry a single colour, per vertex, so merged parts keep theirs. */
function painted(geometry, color) {
  const c = new THREE.Color(color);
  const n = geometry.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** A hover car's hull: a flattened capsule, nose along +x, skids underneath. */
function carHull(scale = 1) {
  const hull = new THREE.CapsuleGeometry(0.42, 1.5, 6, 14)
    .rotateZ(Math.PI / 2)
    .scale(1, 0.62, 1.12);
  const skid = (z) => new THREE.BoxGeometry(1.5, 0.08, 0.14).translate(-0.05, -0.3, z);
  const parts = [hull, skid(0.34), skid(-0.34)].map((g) => {
    g.deleteAttribute('uv');
    if (g.index) return g.toNonIndexed();
    return g;
  });
  const merged = mergeGeometries(parts, false);
  merged.scale(scale, scale, scale);
  return merged;
}

/** The canopy: a tinted glass bubble a little aft of centre. */
const CAR_CANOPY = new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2)
  .scale(0.62, 0.3, 0.4)
  .translate(-0.12, 0.16, 0);

/**
 * Neon trim merged into one geometry, coloured per vertex: a cool-white nose
 * bar, magenta tail bar, and a cyan strip down each flank.
 */
function carLights(scale = 1) {
  const bar = (w, h, d, x, y, z, color) =>
    painted(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color);
  const merged = mergeGeometries(
    [
      bar(0.06, 0.09, 0.7, 1.2, 0.02, 0, '#effcff'),
      bar(0.06, 0.09, 0.8, -1.2, 0.02, 0, '#ff3a8c'),
      bar(1.7, 0.05, 0.04, -0.05, -0.05, 0.48, '#3fe6ff'),
      bar(1.7, 0.05, 0.04, -0.05, -0.05, -0.48, '#3fe6ff'),
    ],
    false
  );
  merged.scale(scale, scale, scale);
  return merged;
}

const CAR_BODY = carHull();
const CAR_CABIN = CAR_CANOPY;
const CAR_LIGHTS = carLights();
const TRAFFIC_BODY = carHull(0.8);
const TRAFFIC_LIGHTS = carLights(0.8);
const RAIN = new THREE.BoxGeometry(0.035, 0.75, 0.035);
const PAD = new THREE.RingGeometry(0.95, 1.25, 28).rotateX(-Math.PI / 2);
/** Car paints: sky-taxi yellow, silver, violet, pink, cyan. */
const PAINTS = ['#f6c945', '#c9cfe0', '#8f7cff', '#ff6aa8', '#5fd4ff', '#e9e4f5'];

// ── Neon sign faces ──────────────────────────────────────────

/** White neon tubes on transparent black; the material tints them per project. */
function neonTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const label = text.length > 18 ? `${text.slice(0, 17)}…` : text;
  let size = 132;
  ctx.font = `700 ${size}px "Arial Rounded MT Bold", "SF Pro Rounded", system-ui, sans-serif`;
  while (ctx.measureText(label.toUpperCase()).width > 860 && size > 40) {
    size -= 6;
    ctx.font = `700 ${size}px "Arial Rounded MT Bold", "SF Pro Rounded", system-ui, sans-serif`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const draw = (blur, alpha, width) => {
    ctx.shadowColor = `rgba(255,255,255,${alpha})`;
    ctx.shadowBlur = blur;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    // The tube frame…
    ctx.beginPath();
    ctx.roundRect(22, 22, 980, 212, 44);
    ctx.stroke();
    // …and the lettering.
    ctx.strokeText(label.toUpperCase(), 512, 134);
  };
  draw(46, 0.5, 14);
  draw(18, 0.85, 8);
  draw(4, 1, 4);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillText(label.toUpperCase(), 512, 134);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** An abstract holographic ad: gradient panels, a ring, scanlines. Tiles vertically to scroll. */
function holoTexture(variant) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const [a, b] = variant ? ['#3fe6ff', '#b06bff'] : ['#ff4fd2', '#ffa23d'];
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 512);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(128, 170, 70, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  for (let i = 0; i < 5; i++) ctx.fillRect(40, 290 + i * 34, 60 + ((i * 53) % 120), 14);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = 0; y < 512; y += 6) ctx.fillRect(0, y, 256, 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ── Hover cursor for instanced, clickable cars ───────────────

function useHoverCursor(hover) {
  useEffect(() => {
    if (!hover) return;
    document.body.style.cursor = 'pointer';
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, [hover]);
}

// ── The city ─────────────────────────────────────────────────

function Skyline({ city, uniforms }) {
  const material = useMemo(
    () => exteriorMaterial(uniforms, { windows: true, roughness: 0.5, metalness: 0.15 }),
    [uniforms]
  );
  const mesh = useMemo(() => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const n = city.buildings.length;
    const tints = new Float32Array(n * 3);
    const seeds = new Float32Array(n);
    const m = new THREE.InstancedMesh(geometry, material, n);
    city.buildings.forEach((b, i) => {
      m.setMatrixAt(
        i,
        boxMatrix(b.x, (b.base + b.top) / 2, b.z, b.w, b.top - b.base, b.d)
      );
      // Darker, cooler facades than the daytime city: glass and steel at night.
      _c.set(TINTS[b.tint]).multiplyScalar(0.55).lerp(_c2.set('#2a2140'), 0.35);
      tints.set([_c.r, _c.g, _c.b], i * 3);
      seeds[i] = b.seed;
    });
    geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    m.frustumCulled = false;
    return m;
  }, [city, material]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.dispose();
    },
    [mesh]
  );
  useEffect(() => () => material.dispose(), [material]);
  return <primitive object={mesh} />;
}

/** Wet streets: a glossy dark ground, pavements, park trees, roof plant, neon kerbs. */
function Streets({ city, uniforms }) {
  const y = city.streetY;
  const blocks = useInstances(
    uniforms,
    BOX,
    city.blocks,
    (b) =>
      boxMatrix(
        (b.x0 + b.x1) / 2,
        y + 0.12,
        (b.z0 + b.z1) / 2,
        b.x1 - b.x0,
        0.24,
        b.z1 - b.z0
      ),
    (b) => (b.park ? '#1b2a22' : '#2a2433')
  );
  const trees = useInstances(
    uniforms,
    BLOB,
    city.trees,
    (t) => boxMatrix(t.x, y + 0.24 + t.r * 1.05, t.z, t.r, t.r * 1.15, t.r),
    () => '#1f3326'
  );
  const roofs = useInstances(
    uniforms,
    BOX,
    city.roofUnits,
    (u) => boxMatrix(u.x, u.base + u.h / 2, u.z, u.w, u.h, u.d),
    (_, i) => (i % 3 ? '#2d2838' : '#3a3346')
  );
  const ground = useMemo(
    () =>
      exteriorMaterial(uniforms, { color: '#120e1b', roughness: 0.22, metalness: 0.6 }),
    [uniforms]
  );
  useEffect(() => () => ground.dispose(), [ground]);

  // Neon along two kerbs of every block: the wet street's reflected glow.
  const kerbs = useMemo(() => {
    const out = [];
    for (const b of city.blocks) {
      out.push({ x: (b.x0 + b.x1) / 2, z: b.z1 + 0.6, w: b.x1 - b.x0, d: 0.22 });
      out.push({ x: b.x1 + 0.6, z: (b.z0 + b.z1) / 2, w: 0.22, d: b.z1 - b.z0 });
    }
    return out;
  }, [city]);
  const kerbMesh = useMemo(() => {
    const m = new THREE.InstancedMesh(
      BOX,
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      kerbs.length
    );
    kerbs.forEach((k, i) => {
      m.setMatrixAt(i, boxMatrix(k.x, y + 0.05, k.z, k.w, 0.06, k.d));
      m.setColorAt(i, _c.copy(i % 3 ? CYAN : MAGENTA).multiplyScalar(0.8));
    });
    m.frustumCulled = false;
    return m;
  }, [kerbs, y]);
  useEffect(
    () => () => {
      kerbMesh.material.dispose();
      kerbMesh.dispose();
    },
    [kerbMesh]
  );

  const cx = (city.room.x0 + city.room.x1) / 2;
  const cz = (city.room.z0 + city.room.z1) / 2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, y, cz]} material={ground}>
        <circleGeometry args={[420, 64]} />
      </mesh>
      <primitive object={blocks.mesh} />
      <primitive object={trees.mesh} />
      <primitive object={roofs.mesh} />
      <primitive object={kerbMesh} />
    </group>
  );
}

/** Two holographic ads on the tallest towers behind and left of the room. */
function Billboards({ city }) {
  const spots = useMemo(() => {
    const tall = city.buildings
      .slice(1)
      .filter((b) => b.top > 14)
      .map((b) => {
        const lot = {
          x0: b.x - b.w / 2,
          x1: b.x + b.w / 2,
          z0: b.z - b.d / 2,
          z1: b.z + b.d / 2,
        };
        return { b, lot, dist: Math.hypot(b.x - city.room.x0, b.z - city.room.z0) };
      })
      .filter(({ lot }) => mayRise(lot, city.block))
      .sort((a, b) => a.dist - b.dist);
    const behind = tall.find(({ lot }) => lot.z1 <= city.block.z0);
    const left = tall.find(
      ({ lot }) => lot.x1 <= city.block.x0 && lot.z1 > city.block.z0
    );
    const out = [];
    // Face the camera's side of the tower: +z for the one behind, +x for the left one.
    if (behind) {
      const { b } = behind;
      const h = Math.min(14, (b.top - b.base) * 0.35);
      out.push({
        x: b.x,
        y: b.top - h / 2 - 2,
        z: b.z + b.d / 2 + 0.3,
        w: Math.min(b.w * 0.7, 8),
        h,
        yaw: 0,
      });
    }
    if (left) {
      const { b } = left;
      const h = Math.min(14, (b.top - b.base) * 0.35);
      out.push({
        x: b.x + b.w / 2 + 0.3,
        y: b.top - h / 2 - 2,
        z: b.z,
        w: Math.min(b.d * 0.7, 8),
        h,
        yaw: Math.PI / 2,
      });
    }
    return out;
  }, [city]);
  const materials = useMemo(
    () =>
      [0, 1].map(
        (v) =>
          new THREE.MeshBasicMaterial({
            map: holoTexture(v),
            transparent: true,
            opacity: 0.75,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            toneMapped: false,
            fog: false,
          })
      ),
    []
  );
  useEffect(
    () => () =>
      materials.forEach((m) => {
        m.map.dispose();
        m.dispose();
      }),
    [materials]
  );
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    materials.forEach((m, i) => {
      m.map.offset.y = (t * 0.04 * (i ? -1 : 1)) % 1;
      // A faint holographic shimmer.
      m.opacity =
        0.62 + 0.08 * Math.sin(t * 7 + i * 2) + (Math.sin(t * 31 + i) > 0.97 ? -0.3 : 0);
    });
  });
  return (
    <group>
      {spots.map((s, i) => (
        <mesh
          key={i}
          position={[s.x, s.y, s.z]}
          rotation={[0, s.yaw, 0]}
          material={materials[i % 2]}
        >
          <planeGeometry args={[s.w, s.h]} />
        </mesh>
      ))}
    </group>
  );
}

// ── Weather and traffic ──────────────────────────────────────

function Rain({ room, uniforms }) {
  const mesh = useMemo(() => {
    const drops = rainDrops(room, 2400);
    const geometry = RAIN.clone();
    const attr = new Float32Array(drops.length * 4);
    const m = new THREE.InstancedMesh(geometry, rainMaterial(uniforms), drops.length);
    drops.forEach((d, i) => {
      m.setMatrixAt(i, _m.makeTranslation(d.x, 0, d.z));
      attr.set([d.top, d.span, d.phase, d.speed], i * 4);
    });
    geometry.setAttribute('aDrop', new THREE.InstancedBufferAttribute(attr, 4));
    m.frustumCulled = false;
    m.renderOrder = 2;
    return m;
  }, [room, uniforms]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    },
    [mesh]
  );
  return <primitive object={mesh} />;
}

function Traffic({ room, seed, uniforms }) {
  const meshes = useMemo(() => {
    const lanes = trafficLanes(room, seed);
    const attr = new Float32Array(lanes.length * 4);
    lanes.forEach((l, i) => attr.set([l.len, l.speed, l.phase, 0], i * 4));
    const make = (base, params) => {
      const geometry = base.clone();
      geometry.setAttribute('aLane', new THREE.InstancedBufferAttribute(attr, 4));
      const m = new THREE.InstancedMesh(
        geometry,
        trafficMaterial(uniforms, params),
        lanes.length
      );
      lanes.forEach((l, i) => m.setMatrixAt(i, boxMatrix(l.x, l.y, l.z, 1, 1, 1, l.yaw)));
      m.frustumCulled = false;
      return m;
    };
    return [
      make(TRAFFIC_BODY, { color: '#4a4560' }),
      make(TRAFFIC_LIGHTS, { vertexColors: true, toneMapped: false }),
    ];
  }, [room, seed, uniforms]);
  useEffect(
    () => () =>
      meshes.forEach((m) => {
        m.geometry.dispose();
        m.material.dispose();
        m.dispose();
      }),
    [meshes]
  );
  return (
    <group>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </group>
  );
}

// ── The sky-dock terrace, its pads and the agents' cars ──────

/** Steel deck plates: seams, a rivet at each corner, faint wear. Tiles every PLATE units. */
const PLATE = 3;
function deckTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#5a556c';
  ctx.fillRect(0, 0, 256, 256);
  let seed = 3;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${rand() < 0.5 ? '255,255,255' : '0,0,0'},0.035)`;
    ctx.fillRect(rand() * 256, rand() * 256, 2 + rand() * 6, 1 + rand() * 3);
  }
  ctx.fillStyle = '#2c2836';
  ctx.fillRect(0, 0, 256, 4);
  ctx.fillRect(0, 0, 4, 256);
  ctx.fillStyle = '#6d6880';
  for (const [x, y] of [
    [14, 14],
    [242, 14],
    [14, 242],
    [242, 242],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The terrace slabs merged into one mesh, each face's UVs scaled to its size
 * in world units so the plate texture tiles evenly across all of them.
 */
function deckGeometry(pieces) {
  const parts = pieces.map((p) => {
    const g = new THREE.BoxGeometry(p.w, p.h, p.d);
    const uv = g.attributes.uv;
    // BoxGeometry faces, 4 vertices each: +x, -x, +y, -y, +z, -z.
    const size = [
      [p.d, p.h],
      [p.d, p.h],
      [p.w, p.d],
      [p.w, p.d],
      [p.w, p.h],
      [p.w, p.h],
    ];
    for (let i = 0; i < uv.count; i++) {
      const [su, sv] = size[Math.floor(i / 4)];
      uv.setXY(i, (uv.getX(i) * su) / PLATE, (uv.getY(i) * sv) / PLATE);
    }
    return g.translate(p.x, p.y, p.z);
  });
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}

function Terrace({ room }) {
  const pieces = useMemo(() => deckPieces(room), [room]);
  const geometry = useMemo(() => deckGeometry(pieces), [pieces]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: deckTexture(),
        roughness: 0.48,
        metalness: 0.35,
      }),
    []
  );
  useEffect(
    () => () => {
      material.map.dispose();
      material.dispose();
    },
    [material]
  );
  // Glowing edge strips along the terrace's outer rim.
  const strips = useMemo(() => {
    const r = roomBox(room);
    const D = DECK_DEPTH;
    return [
      { x: (r.x0 - D + r.x1) / 2, z: r.z0 - D, w: r.x1 - r.x0 + D, d: 0.12 },
      { x: r.x1 - 0.06, z: r.z0 - D / 2, w: 0.12, d: D },
      { x: r.x0 - D, z: (r.z0 - D + r.z1) / 2, w: 0.12, d: r.z1 - r.z0 + D },
      { x: r.x0 - D / 2, z: r.z1 - 0.06, w: D, d: 0.12 },
    ];
  }, [room]);
  const stripMesh = useMemo(() => {
    const m = new THREE.InstancedMesh(
      BOX,
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      strips.length
    );
    strips.forEach((s, i) => {
      m.setMatrixAt(i, boxMatrix(s.x, 0.04, s.z, s.w, 0.08, s.d));
      m.setColorAt(i, i % 2 ? CYAN : MAGENTA);
    });
    m.frustumCulled = false;
    return m;
  }, [strips]);
  useEffect(
    () => () => {
      stripMesh.material.dispose();
      stripMesh.dispose();
    },
    [stripMesh]
  );
  return (
    <group>
      <mesh geometry={geometry} material={material} />
      <primitive object={stripMesh} />
    </group>
  );
}

/**
 * The agents' flying cars and their dock pads. Who sits at which dock is
 * sticky (stickySlots); `cars` is rebuilt on every snapshot, the motion is
 * computed per frame from wall-clock event times.
 */
function Cars({ room, cars, onSelect }) {
  const docks = useMemo(() => dockSlots(room), [room]);
  const n = docks.length;
  const meshes = useMemo(() => {
    const body = new THREE.InstancedMesh(
      CAR_BODY,
      // White, so each car's paint (instance colour) shows as itself.
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        roughness: 0.3,
        metalness: 0.25,
      }),
      n
    );
    const cabin = new THREE.InstancedMesh(
      CAR_CABIN,
      // Tinted glass with the cabin's own glow behind it.
      new THREE.MeshStandardMaterial({
        color: '#2a4f6e',
        roughness: 0.05,
        metalness: 0.5,
        emissive: '#123a55',
      }),
      n
    );
    const lights = new THREE.InstancedMesh(
      CAR_LIGHTS,
      new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      n
    );
    const pads = new THREE.InstancedMesh(
      PAD,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      n
    );
    docks.forEach((d, i) => {
      pads.setMatrixAt(i, _m.makeTranslation(d.x, 0.03, d.z));
      pads.setColorAt(i, _c.set('#3a3550'));
      for (const m of [body, cabin, lights]) m.setMatrixAt(i, ZERO);
      body.setColorAt(i, _c.set(PAINTS[i % PAINTS.length]));
    });
    for (const m of [body, cabin, lights, pads]) m.frustumCulled = false;
    return { body, cabin, lights, pads };
  }, [docks, n]);
  useEffect(
    () => () =>
      Object.values(meshes).forEach((m) => {
        m.material.dispose();
        m.dispose();
      }),
    [meshes]
  );

  // The latest cars list, read by the frame loop without re-subscribing it.
  const carsRef = useRef(cars);
  carsRef.current = cars;
  const [hover, setHover] = useState(false);
  useHoverCursor(hover);

  useFrame(({ clock }) => {
    const now = Date.now();
    const t = clock.elapsedTime;
    const list = carsRef.current;
    for (let i = 0; i < n; i++) {
      const car = list[i];
      const dock = docks[i];
      if (!car) {
        meshes.body.setMatrixAt(i, ZERO);
        meshes.cabin.setMatrixAt(i, ZERO);
        meshes.lights.setMatrixAt(i, ZERO);
        meshes.pads.setColorAt(i, _c.set('#3a3550'));
        continue;
      }
      // Where the car is and which way it points.
      let x = dock.x;
      let y = PARK_Y + Math.sin(t * 1.6 + i * 1.3) * 0.05;
      let z = dock.z;
      let yaw = dock.yaw;
      let bank = 0;
      let visible = true;
      const far = 70;
      if (car.leaveAt !== null) {
        const k = (now - car.leaveAt) / 1000 / LEAVE_S;
        if (k >= 1 || k < 0) visible = false;
        else {
          const lift = ease(k / 0.3);
          const go = ease((k - 0.25) / 0.75);
          x += dock.out[0] * far * go;
          z += dock.out[1] * far * go;
          y += 2.4 * lift + 16 * go;
          const heading = Math.atan2(-dock.out[1], dock.out[0]);
          yaw = dock.yaw + (heading - dock.yaw) * ease((k - 0.15) / 0.35);
          bank = -0.25 * Math.sin(Math.PI * Math.min(1, go * 1.4));
        }
      } else if (car.arriveAt !== null) {
        const k = (now - car.arriveAt) / 1000 / ARRIVE_S;
        if (k >= 0 && k < 1) {
          const come = 1 - ease(k);
          x += dock.out[0] * far * come;
          z += dock.out[1] * far * come;
          y += 18 * come * come + 2 * Math.sin(Math.PI * k) * come;
          const heading = Math.atan2(dock.out[1], -dock.out[0]);
          yaw = heading + (dock.yaw - heading) * ease((k - 0.65) / 0.35);
          bank = 0.22 * Math.sin(Math.PI * Math.min(1, k * 1.3));
        }
      }
      if (!visible) {
        meshes.body.setMatrixAt(i, ZERO);
        meshes.cabin.setMatrixAt(i, ZERO);
        meshes.lights.setMatrixAt(i, ZERO);
      } else {
        _q.setFromEuler(_e.set(bank, yaw, 0, 'YXZ'));
        _m.compose(_p.set(x, y, z), _q, _s.set(1, 1, 1));
        meshes.body.setMatrixAt(i, _m);
        meshes.cabin.setMatrixAt(i, _m);
        meshes.lights.setMatrixAt(i, _m2.copy(_m));
      }
      // The pad glows in the agent's state colour; waiting blinks amber.
      const blink =
        car.state === 'waiting_on_user' ? 0.45 + 0.55 * Math.abs(Math.sin(t * 3.2)) : 1;
      _c.set(stateColor[car.state] ?? '#7c7896').multiplyScalar(
        blink * (car.leaveAt !== null ? 0.3 : 1)
      );
      meshes.pads.setColorAt(i, _c);
    }
    meshes.body.instanceMatrix.needsUpdate = true;
    meshes.cabin.instanceMatrix.needsUpdate = true;
    meshes.lights.instanceMatrix.needsUpdate = true;
    meshes.pads.instanceColor.needsUpdate = true;
    // Moving cars: keep the click target where they are.
    meshes.body.computeBoundingSphere();
  });

  const pick = (e) => {
    e.stopPropagation();
    const car = carsRef.current[e.instanceId];
    if (car && car.leaveAt === null) onSelect({ pid: car.pid });
  };
  return (
    <group>
      <primitive object={meshes.pads} />
      <primitive
        object={meshes.body}
        onClick={pick}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      />
      <primitive object={meshes.cabin} onClick={pick} />
      <primitive object={meshes.lights} />
    </group>
  );
}

// ── Project signs ────────────────────────────────────────────

/** The posts and dark backing of every lit sign: one instanced mesh. */
function SignHardware({ signs }) {
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(
      BOX,
      new THREE.MeshStandardMaterial({
        color: '#16131f',
        roughness: 0.6,
        metalness: 0.5,
      }),
      Math.max(1, signs.length * 3)
    );
    m.count = signs.length * 3;
    signs.forEach((s, i) => {
      const nx = Math.sin(s.yaw);
      const nz = Math.cos(s.yaw);
      // Backing panel, a hand's width behind the tubes.
      m.setMatrixAt(
        i * 3,
        boxMatrix(
          s.x - nx * 0.08,
          s.y,
          s.z - nz * 0.08,
          SIGN_W + 0.2,
          SIGN_H + 0.2,
          0.08,
          s.yaw
        )
      );
      // Two posts down to the wall top.
      const postH = s.y - SIGN_H / 2 - 3.1;
      for (const k of [0, 1]) {
        const off = (k ? 1 : -1) * (SIGN_W / 2 - 0.5);
        m.setMatrixAt(
          i * 3 + 1 + k,
          boxMatrix(
            s.x - nx * 0.08 + nz * off,
            3.1 + postH / 2,
            s.z - nz * 0.08 - nx * off,
            0.08,
            postH,
            0.08,
            s.yaw
          )
        );
      }
    });
    m.frustumCulled = false;
    return m;
  }, [signs]);
  useEffect(
    () => () => {
      mesh.material.dispose();
      mesh.dispose();
    },
    [mesh]
  );
  return <primitive object={mesh} />;
}

/** One project's neon: lettering tinted its colour, dimmed when idle, amber while waiting. */
function NeonSign({ sign, project, onSelect, dark }) {
  const texture = useMemo(() => neonTexture(project.key), [project.key]);
  useEffect(() => () => texture.dispose(), [texture]);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [texture]
  );
  useEffect(() => () => material.dispose(), [material]);
  const base = useMemo(() => new THREE.Color(neonFor(project.key)), [project.key]);
  const amber = useMemo(() => new THREE.Color(NEON_WAITING), []);
  const live = useRef(project);
  live.current = project;

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const p = live.current;
    let level = p.busy ? 1.15 : 0.42;
    _c.copy(base);
    if (p.waiting) _c.lerp(amber, 0.55 + 0.45 * Math.sin(t * 4.2));
    const since = p.finishedAt === null ? Infinity : (Date.now() - p.finishedAt) / 1000;
    if (since < FLICKER_S) {
      // A finished turn: the tubes stutter and flare white.
      const on = Math.sin(t * 47 + since * 9) > -0.2 ? 1 : 0.15;
      level = (1.5 - since / FLICKER_S) * on + 0.3;
      _c.lerp(WHITE, 0.5 * (1 - since / FLICKER_S));
    }
    level *= 1 - 0.75 * dark.current;
    material.color.copy(_c).multiplyScalar(level);
  });

  return (
    <Clickable
      pid={project.focusPid}
      onSelect={project.focusPid === null ? () => {} : onSelect}
      position={[sign.x, sign.y, sign.z]}
      rotation={[0, sign.yaw, 0]}
    >
      <mesh material={material}>
        <planeGeometry args={[SIGN_W, SIGN_H]} />
      </mesh>
    </Clickable>
  );
}

// ── Lightning ────────────────────────────────────────────────

/** A jagged bolt from the clouds behind and left of the tower, drawn only mid-strike. */
function boltGeometry() {
  const parts = [];
  let x = 0;
  let y = 80;
  let z = 0;
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  while (y > 6) {
    const nx = x + (rand() - 0.5) * 7;
    const ny = y - 5 - rand() * 6;
    const nz = z + (rand() - 0.5) * 4;
    const len = Math.hypot(nx - x, ny - y, nz - z);
    const g = new THREE.BoxGeometry(0.35, len, 0.35);
    _q.setFromUnitVectors(_p.set(0, 1, 0), _s.set(nx - x, ny - y, nz - z).normalize());
    g.applyMatrix4(
      _m.compose(_p.set((x + nx) / 2, (y + ny) / 2, (z + nz) / 2), _q, _s.set(1, 1, 1))
    );
    parts.push(g);
    x = nx;
    y = ny;
    z = nz;
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}

/** How much brighter the scene's environment light gets at a strike's peak. */
const FLASH_ENV = 7;

/**
 * The strike lights the room through the scene's environment intensity, a
 * uniform three sets on every draw, rather than a light of its own. An extra
 * light, even at intensity 0, would make every material in the room compile a
 * variant for it and evaluate it per pixel on every frame between strikes.
 */
function Lightning({ room, look, errorAt, dark, uniforms }) {
  const scene = useThree((s) => s.scene);
  const bolt = useRef(null);
  const geometry = useMemo(() => boltGeometry(), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const fogBase = useMemo(() => new THREE.Color(look.fog), [look.fog]);
  const r = roomBox(room);
  const strike = useRef({ at: null, flashing: false, env: look.env });
  strike.current.at = errorAt;
  // What the room's Environment sets; the flash multiplies it and puts it back.
  strike.current.env = look.env;

  useFrame(() => {
    const s = strike.current;
    const age = s.at === null ? Infinity : (Date.now() - s.at) / 1000;
    const f = lightningFlash(age);
    dark.current = lightningDark(age);
    uniforms.uNight.value = look.windows * (1 - 0.65 * dark.current);
    if (bolt.current) bolt.current.visible = f > 0.04;
    if (f > 0 || s.flashing) {
      scene.backgroundIntensity = 1 + f * 2.2;
      scene.environmentIntensity = s.env * (1 + f * FLASH_ENV);
      scene.fog?.color.copy(fogBase).lerp(FLASH, f * 0.4);
      s.flashing = f > 0;
    }
  });
  useEffect(
    () => () => {
      scene.backgroundIntensity = 1;
      if (strike.current.flashing) scene.environmentIntensity = strike.current.env;
    },
    [scene]
  );

  return (
    <mesh
      ref={bolt}
      geometry={geometry}
      position={[r.x0 - 48, 0, r.z0 - 75]}
      visible={false}
    >
      <meshBasicMaterial color="#eef1ff" toneMapped={false} fog={false} />
    </mesh>
  );
}

// ── The environment ──────────────────────────────────────────

/** Latest event time of a type for a pid (or any pid of a set), or null. */
function lastAt(events, type, match) {
  let at = null;
  for (const e of events)
    if (e.type === type && match(e.pid) && (at === null || e.at > at)) at = e.at;
  return at;
}

/** See ./index.js for the props every environment receives. */
export const Cyberpunk = memo(function Cyberpunk({
  plan,
  kind,
  look,
  office,
  events,
  onSelect,
}) {
  const invalidate = useThree((s) => s.invalidate);
  const { minX, maxX, minZ, maxZ } = plan;
  // Bounds as one stable object: every layout below follows only these.
  const room = useMemo(() => ({ minX, maxX, minZ, maxZ }), [minX, maxX, minZ, maxZ]);
  const city = useMemo(() => planCity(room, { seed: seedFor(kind) }), [room, kind]);
  const uniforms = useMemo(() => {
    const u = makeExteriorUniforms({
      haze: 0.6,
      hazeDepth: -STREET_Y,
      streetY: STREET_Y,
    });
    u.uGlowA.value.copy(WINDOW_A);
    u.uGlowB.value.copy(WINDOW_B);
    u.uTime = { value: 0 };
    return u;
  }, []);
  // The lightning's thunder-dark (0..1), shared with the signs by ref.
  const dark = useRef(0);

  useLayoutEffect(() => {
    uniforms.uNight.value = look.windows;
    uniforms.uDay.value = look.day;
    uniforms.uGlass.value.set(look.skyHorizon);
    invalidate();
  }, [look, uniforms, invalidate]);
  useFrame(({ clock }) => {
    uniforms.uTime.value = clock.elapsedTime;
  });

  // Agents → flying cars, by sticky dock.
  const docks = useMemo(() => dockSlots(room), [room]);
  const dockOf = useRef(new Map());
  const cars = useMemo(() => {
    const sessions = liveSessions(office, { ended: true });
    dockOf.current = stickySlots(
      dockOf.current,
      sessions.map((s) => s.pid),
      docks.length
    );
    const list = new Array(docks.length).fill(null);
    for (const s of sessions) {
      const slot = dockOf.current.get(s.pid);
      if (slot === undefined) continue;
      const ended = s.state === 'ended';
      const leftAt = lastAt(events, 'left', (pid) => pid === s.pid);
      list[slot] = {
        pid: s.pid,
        state: s.state,
        arriveAt: lastAt(events, 'arrived', (pid) => pid === s.pid),
        // Ended with no departure seen (it ended before the page opened): already gone.
        leaveAt: ended ? (leftAt ?? 0) : null,
      };
    }
    return list;
  }, [office, events, docks]);

  // Projects → neon signs, by sticky sign slot.
  const signSpots = useMemo(() => signSlots(room), [room]);
  const signOf = useRef(new Map());
  const projects = useMemo(() => {
    const keys = plan.pods.map((p) => p.projectKey);
    signOf.current = stickySlots(signOf.current, keys, signSpots.length);
    return plan.pods
      .filter((p) => signOf.current.has(p.projectKey))
      .map((pod) => {
        const live = pod.desks
          .map((d) => d.session)
          .filter((s) => s && s.state !== 'ended');
        const pids = new Set(live.map((s) => s.pid));
        return {
          key: pod.projectKey,
          slot: signOf.current.get(pod.projectKey),
          busy: live.some((s) => s.state === 'working' || s.state === 'thinking'),
          waiting: live.some((s) => s.state === 'waiting_on_user'),
          finishedAt: lastAt(events, 'finished', (pid) => pids.has(pid)),
          focusPid: live[0]?.pid ?? null,
        };
      });
    // plan is new every snapshot; its pods only change with the office.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [office, events, signSpots]);
  const usedSigns = useMemo(
    () => projects.map((p) => signSpots[p.slot]),
    [projects, signSpots]
  );

  const errorAt = lastAt(events, 'error', () => true);

  return (
    <group>
      <Atmosphere look={look} fogFar={FOG_FAR} invalidate={invalidate} />
      <Skyline city={city} uniforms={uniforms} />
      <Streets city={city} uniforms={uniforms} />
      <Billboards city={city} />
      <Rain room={room} uniforms={uniforms} />
      <Traffic room={room} seed={seedFor(kind)} uniforms={uniforms} />
      <Terrace room={room} />
      <Cars room={room} cars={cars} onSelect={onSelect} />
      <SignHardware signs={usedSigns} />
      {projects.map((p) => (
        <NeonSign
          key={p.key}
          sign={signSpots[p.slot]}
          project={p}
          onSelect={onSelect}
          dark={dark}
        />
      ))}
      <Lightning
        room={room}
        look={look}
        errorAt={errorAt}
        dark={dark}
        uniforms={uniforms}
      />
    </group>
  );
});
