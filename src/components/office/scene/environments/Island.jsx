import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { stickySlots } from '../../../../lib/office/agentEvents.js';
import { rng } from '../../../../lib/office/scene/city.js';
import {
  DECK_BOTTOM,
  DECK_TOP,
  MOORINGS,
  PIER_TOP,
  PIER_W,
  SAIL_IN_S,
  SAIL_OUT_S,
  SEA_Y,
  TERRAIN_GLSL,
  islandLayout,
  islandScenery,
  leapSpot,
  rainDrops,
  sailIn,
  sailOut,
  shoreDistance,
  terrainHeight,
} from '../../../../lib/office/scene/island.js';
import {
  Atmosphere,
  BLOB,
  BOX,
  Clickable,
  boxMatrix,
  dayFactor,
  exteriorMaterial,
  liveSessions,
  makeExteriorUniforms,
  useInstances,
} from './common.jsx';

// ── Tropical island ──────────────────────────────────────────
// The room as an open-air pavilion on a wooden deck over a lagoon: the beach
// and a palm grove behind it, a pier running out to sea, turquoise water with
// rolling waves and surf. The layout (and its keep-clear-of-the-camera rules)
// lives in the pure lib/office/scene/island.js; this file draws it.
//
// How it answers the agents:
//   - every live session has a boat at its own mooring (sticky slot); one that
//     just arrived sails in from the open sea, one that ended sails away;
//   - a boat's mast lantern blinks amber while its agent waits on you and
//     glows red while it is in error; clicking a boat focuses its agent;
//   - a finished turn sends a dolphin leaping beside that agent's boat;
//   - while any agent errors a squall rolls in: dark clouds, rain, whitecaps,
//     palms bending (the look darkens the light, environments.js STORM);
//   - after dark the pier and deck lanterns glow.
//
// Budget: ~21 draw calls (rain, dolphins and splashes only while they play),
// waves in the vertex shader, nothing outdoors in the shadow map, and every
// per-frame update writes into scratch objects.

const seedFor = (kind) => (kind === 'antigravity' ? 23 : 5);

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _c = new THREE.Color();
const _c2 = new THREE.Color();

/**
 * Keeps materials at the time of day's brightness, dimmed further under a
 * storm's cloud as it eases in. Per frame, but only a setScalar each.
 */
function useStormShade(materials, base, storm) {
  useFrame(() => {
    const k = base * (1 - 0.3 * storm.current.value);
    for (const m of materials) m.color.setScalar(k);
  });
}

/** Shared state the storm eases through, read by every animated part. */
function useStorm(mood) {
  const storm = useRef({ value: mood.error > 0 ? 1 : 0, target: 0 });
  storm.current.target = mood.error > 0 ? 1 : 0;
  useFrame((_, dt) => {
    const s = storm.current;
    s.value += (s.target - s.value) * Math.min(1, dt * 0.7);
  });
  return storm;
}

// ── Wood ─────────────────────────────────────────────────────

let plankTex = null;
/** Weathered deck boards, drawn once. */
function plankTexture() {
  if (plankTex) return plankTex;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const r = rng(17);
  const boards = 8;
  for (let i = 0; i < boards; i++) {
    const shade = 0.88 + r() * 0.16;
    ctx.fillStyle = `rgb(${Math.round(176 * shade)}, ${Math.round(132 * shade)}, ${Math.round(
      92 * shade
    )})`;
    ctx.fillRect(0, (i * 256) / boards, 256, 256 / boards);
    ctx.fillStyle = 'rgba(70, 45, 25, 0.55)';
    ctx.fillRect(0, (i * 256) / boards, 256, 2);
    for (let k = 0; k < 5; k++) {
      ctx.fillStyle = `rgba(90, 60, 35, ${0.08 + r() * 0.1})`;
      ctx.fillRect(r() * 256, (i * 256) / boards + 4 + r() * 22, 30 + r() * 80, 1);
    }
  }
  plankTex = new THREE.CanvasTexture(canvas);
  plankTex.colorSpace = THREE.SRGBColorSpace;
  plankTex.wrapS = plankTex.wrapT = THREE.RepeatWrapping;
  plankTex.anisotropy = 8;
  return plankTex;
}

const POST = new THREE.CylinderGeometry(0.15, 0.17, 1, 7);
const LAMP = new THREE.BoxGeometry(1, 1, 1);

/** The deck under the room, its stilts, the steps, the pier and its lanterns. */
const Deck = memo(function Deck({ layout, look, uniforms }) {
  const { deck, pier, room } = layout;
  const deckTex = useMemo(() => {
    const t = plankTexture().clone();
    t.repeat.set((deck.x1 - deck.x0) / 2.6, (deck.z1 - deck.z0) / 2.6);
    t.needsUpdate = true;
    return t;
  }, [deck.x0, deck.x1, deck.z0, deck.z1]);
  const pierTex = useMemo(() => {
    const t = plankTexture().clone();
    t.rotation = Math.PI / 2;
    t.repeat.set(PIER_W / 2.6, (pier.x1 - pier.x0) / 2.6);
    t.needsUpdate = true;
    return t;
  }, [pier.x0, pier.x1]);
  useEffect(() => () => deckTex.dispose(), [deckTex]);
  useEffect(() => () => pierTex.dispose(), [pierTex]);

  const deckMat = useMemo(
    () => exteriorMaterial(uniforms, { map: deckTex, roughness: 0.85 }),
    [uniforms, deckTex]
  );
  const pierMat = useMemo(
    () => exteriorMaterial(uniforms, { map: pierTex, roughness: 0.85 }),
    [uniforms, pierTex]
  );
  useEffect(() => () => deckMat.dispose(), [deckMat]);
  useEffect(() => () => pierMat.dispose(), [pierMat]);

  // Stilts round the deck's edge and through its middle, posts along the
  // pier, and short lantern posts on the pier.
  const posts = useMemo(() => {
    const list = [];
    const bottom = -5;
    const stilt = (x, z) => list.push({ x, z, top: DECK_BOTTOM, bottom, r: 1 });
    for (let x = deck.x0 + 0.4; x <= deck.x1 - 0.3; x += 3) {
      stilt(x, deck.z0 + 0.4);
      stilt(x, deck.z1 - 0.4);
      stilt(x, (deck.z0 + deck.z1) / 2);
    }
    for (let z = deck.z0 + 3.4; z <= deck.z1 - 3; z += 3) {
      stilt(deck.x0 + 0.4, z);
      stilt(deck.x1 - 0.4, z);
    }
    for (let x = pier.x0 + 2.8; x <= pier.x1 - 0.2; x += 3.7) {
      for (const side of [-1, 1])
        list.push({
          x,
          z: pier.z + side * (PIER_W / 2 - 0.12),
          top: PIER_TOP,
          bottom,
          r: 0.9,
        });
    }
    // Lantern posts: on the pier, every other post, alternating sides.
    for (let i = 0, x = pier.x0 + 4.6; x <= pier.x1 - 0.5; x += 7.4, i++) {
      const side = i % 2 ? 1 : -1;
      list.push({
        x,
        z: pier.z + side * (PIER_W / 2 - 0.15),
        top: PIER_TOP + 0.85,
        bottom: PIER_TOP,
        r: 0.45,
      });
    }
    return list;
  }, [deck.x0, deck.x1, deck.z0, deck.z1, pier.x0, pier.x1, pier.z]);
  const postMesh = useInstances(
    uniforms,
    POST,
    posts,
    (p) => boxMatrix(p.x, (p.top + p.bottom) / 2, p.z, p.r, p.top - p.bottom, p.r),
    (p) => (p.r < 0.6 ? '#4a3a2c' : '#7d5a3c'),
    { roughness: 0.9 }
  );

  // Steps from the deck down to the pier.
  const steps = useMemo(() => {
    const n = 4;
    const drop = (DECK_TOP - PIER_TOP) / n;
    return Array.from({ length: n }, (_, i) => ({
      x: deck.x1 + 0.35 + i * 0.6,
      y: DECK_TOP - drop * (i + 1) + 0.06,
      z: pier.z,
    }));
  }, [deck.x1, pier.z]);
  const stepMesh = useInstances(
    uniforms,
    BOX,
    steps,
    (s) => boxMatrix(s.x, s.y - 0.08, s.z, 0.62, 0.16, PIER_W),
    () => '#b4855b',
    { roughness: 0.85 }
  );

  // Lanterns: heads on the pier posts, and lights set into the deck's edge.
  const lamps = useMemo(() => {
    const list = [];
    for (let i = 0, x = pier.x0 + 4.6; x <= pier.x1 - 0.5; x += 7.4, i++) {
      const side = i % 2 ? 1 : -1;
      list.push({
        x,
        y: PIER_TOP + 0.95,
        z: pier.z + side * (PIER_W / 2 - 0.15),
        s: 0.24,
      });
    }
    for (let x = room.x0 + 1; x < deck.x1 - 0.5; x += 2.6)
      list.push({ x, y: DECK_TOP - 0.12, z: deck.z1 + 0.02, s: 0.16 });
    for (let z = room.z0 + 1; z < deck.z1 - 0.5; z += 2.6)
      list.push({ x: deck.x1 + 0.02, y: DECK_TOP - 0.12, z, s: 0.16 });
    return list;
  }, [deck.x1, deck.z1, pier.x0, pier.x1, pier.z, room.x0, room.z0]);
  const lampMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
    []
  );
  const lampMesh = useMemo(() => {
    const m = new THREE.InstancedMesh(LAMP, lampMat, Math.max(lamps.length, 1));
    m.count = lamps.length;
    lamps.forEach((l, i) =>
      m.setMatrixAt(i, boxMatrix(l.x, l.y, l.z, l.s, l.s * 1.2, l.s))
    );
    m.frustumCulled = false;
    return m;
  }, [lamps, lampMat]);
  useEffect(() => () => lampMesh.dispose(), [lampMesh]);
  useEffect(() => () => lampMat.dispose(), [lampMat]);

  useLayoutEffect(() => {
    // Wood stays readable at night: the lanterns light it.
    const k = 0.32 + 0.68 * look.day;
    deckMat.color.setScalar(k);
    pierMat.color.setScalar(k);
    postMesh.material.color.setScalar(k);
    stepMesh.material.color.setScalar(k);
    lampMat.color.set('#5b4a38').lerp(_c.set('#ffcf86'), look.windows);
  }, [look, deckMat, pierMat, postMesh.material, stepMesh.material, lampMat]);

  return (
    <group>
      <mesh
        position={[
          (deck.x0 + deck.x1) / 2,
          (DECK_TOP + DECK_BOTTOM) / 2,
          (deck.z0 + deck.z1) / 2,
        ]}
        material={deckMat}
      >
        <boxGeometry
          args={[deck.x1 - deck.x0, DECK_TOP - DECK_BOTTOM, deck.z1 - deck.z0]}
        />
      </mesh>
      <mesh
        position={[(pier.x0 + 2.4 + pier.x1) / 2, PIER_TOP - 0.11, pier.z]}
        material={pierMat}
      >
        <boxGeometry args={[pier.x1 - pier.x0 - 2.4, 0.22, PIER_W]} />
      </mesh>
      <primitive object={postMesh.mesh} />
      <primitive object={stepMesh.mesh} />
      <primitive object={lampMesh} />
    </group>
  );
});

// ── Beach and sea ────────────────────────────────────────────

const SAND = new THREE.Color('#efdcae');
const WET_SAND = new THREE.Color('#c9ae84');
const SEABED = new THREE.Color('#d8c597');
const GRASS = new THREE.Color('#9dbb6c');

/** The beach and seabed: one height field, coloured by distance to the surf. */
const Ground = memo(function Ground({ layout, look, uniforms, storm }) {
  const { c } = layout;
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(460, 460, 184, 184);
    g.rotateX(-Math.PI / 2);
    g.translate(c.cx, 0, c.cz);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, terrainHeight(x, z, c));
      const d = shoreDistance(x, z, c);
      if (d > 0.6) _c.copy(SEABED);
      else if (d > -1.4) _c.copy(WET_SAND).lerp(SAND, (-d + 0.6) / 2);
      else _c.copy(SAND).lerp(GRASS, Math.min(1, Math.max(0, (-d - 12) / 10)));
      colors.set([_c.r, _c.g, _c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, [c]);
  const material = useMemo(
    () => exteriorMaterial(uniforms, { vertexColors: true, roughness: 1 }),
    [uniforms]
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  useStormShade([material], dayFactor(look), storm);
  return <mesh geometry={geometry} material={material} />;
});

const SEA_VERTEX_DECL = /* glsl */ `
uniform float uTime;
uniform float uStorm;
uniform vec2 uCenter;
varying vec3 vSeaPos;
${TERRAIN_GLSL}
float seaWave( vec2 p, float t ) {
  return 0.16 * sin( p.x * 0.31 + t * 1.05 )
       + 0.12 * sin( p.y * 0.37 - t * 0.85 + p.x * 0.11 )
       + 0.06 * sin( ( p.x + p.y ) * 0.83 + t * 1.6 );
}
`;

const SEA_VERTEX = /* glsl */ `
vec4 seaWorld = modelMatrix * vec4( transformed, 1.0 );
float seaCalm = smoothstep( 0.0, 4.0, ${SEA_Y.toFixed(2)} - islandGround( seaWorld.xz ) );
float seaAmp = ( 0.55 + uStorm * 1.3 ) * ( 0.3 + 0.7 * seaCalm );
transformed.y += seaAmp * seaWave( seaWorld.xz, uTime );
vSeaPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const SEA_FRAGMENT_DECL = /* glsl */ `
uniform float uTime;
uniform float uStorm;
uniform float uDay;
uniform vec2 uCenter;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uStormSea;
uniform vec3 uFoam;
varying vec3 vSeaPos;
${TERRAIN_GLSL}
`;

// Turquoise over the sand, deep blue further out, a moving band of surf where
// the water meets the beach, whitecaps on the crests in a storm.
const SEA_FRAGMENT = /* glsl */ `
{
  float seaDepth = ${SEA_Y.toFixed(2)} - islandGround( vSeaPos.xz );
  vec3 water = mix( uShallow, uDeep, smoothstep( 0.2, 4.2, seaDepth ) );
  water = mix( water, uStormSea, uStorm * 0.7 );
  float band = 0.13 + 0.07 * sin( uTime * 1.3 + vSeaPos.x * 0.23 + vSeaPos.z * 0.17 );
  float surf = 1.0 - smoothstep( 0.0, band, seaDepth );
  float caps = uStorm * smoothstep( 0.22, 0.5, vSeaPos.y - ${SEA_Y.toFixed(2)} );
  water = mix( water, uFoam, clamp( surf * 0.85 + caps * 0.7, 0.0, 1.0 ) );
  diffuseColor.rgb = water * ( 0.16 + 0.84 * uDay );
}
`;

/** The sea: a flat-shaded plane whose waves are drawn in the vertex shader. */
const Sea = memo(function Sea({ layout, look, storm }) {
  const { c } = layout;
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uStorm: { value: 0 },
      uDay: { value: 1 },
      uCenter: { value: new THREE.Vector2(c.cx, c.cz) },
      uShallow: { value: new THREE.Color('#48d1c6') },
      uDeep: { value: new THREE.Color('#1c6f9c') },
      uStormSea: { value: new THREE.Color('#4d6670') },
      uFoam: { value: new THREE.Color('#f4fbfb') },
    }),
    [c]
  );
  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      flatShading: true,
      roughness: 0.18,
      metalness: 0.05,
      envMapIntensity: 0.9,
    });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${SEA_VERTEX_DECL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SEA_VERTEX}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${SEA_FRAGMENT_DECL}`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>\n${SEA_FRAGMENT}`
        );
    };
    m.customProgramCacheKey = () => 'wpxen-office-island-sea';
    return m;
  }, [uniforms]);
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(560, 560, 160, 160);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    uniforms.uDay.value = look.day;
  }, [look, uniforms]);
  useFrame(({ clock }) => {
    uniforms.uTime.value = clock.elapsedTime;
    uniforms.uStorm.value = storm.current.value;
  });

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[c.cx, SEA_Y, c.cz]}
      frustumCulled={false}
    />
  );
});

// ── Palms, bushes, hills ─────────────────────────────────────

/** A trunk curving gently toward +x, one unit tall (scaled per palm). */
const TRUNK = (() => {
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.05, 0.55, 0),
    new THREE.Vector3(0.24, 1, 0)
  );
  return new THREE.TubeGeometry(curve, 8, 0.17, 6, false);
})();
const TRUNK_TIP = new THREE.Vector3(0.24, 1, 0);

/** Nine drooping fronds and a cluster of coconuts, vertex-coloured, merged. */
const CROWN = (() => {
  const parts = [];
  const leaf = new THREE.Color();
  for (let i = 0; i < 9; i++) {
    const g = new THREE.PlaneGeometry(0.62, 2.5, 1, 6).toNonIndexed();
    const pos = g.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      const along = pos.getY(k) + 1.25; // 0 at the crown, 2.5 at the tip
      const width = 1 - along / 2.9;
      pos.setXYZ(
        k,
        pos.getX(k) * width,
        -0.09 * along * along + 0.35 * along * 0.4,
        along
      );
    }
    g.rotateY((i / 9) * Math.PI * 2 + (i % 2) * 0.2);
    leaf.set(i % 3 === 0 ? '#3f7d3a' : i % 3 === 1 ? '#4f9444' : '#5c9d48');
    const colors = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) colors.set([leaf.r, leaf.g, leaf.b], k * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    parts.push(g);
  }
  const nut = new THREE.Color('#6b4a2b');
  for (let i = 0; i < 4; i++) {
    const g = new THREE.IcosahedronGeometry(0.16, 0);
    g.translate(Math.cos(i * 1.7) * 0.18, -0.18, Math.sin(i * 1.7) * 0.18);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) colors.set([nut.r, nut.g, nut.b], k * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(g);
  }
  return mergeGeometries(parts, false);
})();

const Palms = memo(function Palms({ scenery, look, uniforms, storm }) {
  const { palms } = scenery;
  // Each palm's trunk transform, and where its crown sits.
  const placed = useMemo(
    () =>
      palms.map((p) => {
        _e.set(0, p.yaw, p.lean, 'YXZ');
        _q.setFromEuler(_e);
        const m = new THREE.Matrix4().compose(
          _p.set(p.x, p.y - 0.2, p.z),
          _q,
          _s.set(1, p.height, 1)
        );
        const tip = TRUNK_TIP.clone().applyMatrix4(m);
        return { trunk: m, tip, size: p.height / 6.2, phase: p.phase, yaw: p.yaw };
      }),
    [palms]
  );
  const trunks = useInstances(
    uniforms,
    TRUNK,
    placed,
    (p) => p.trunk,
    () => '#8d6b47',
    { roughness: 0.95 }
  );
  const crownMat = useMemo(
    () =>
      exteriorMaterial(uniforms, {
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.8,
        flatShading: true,
      }),
    [uniforms]
  );
  const crowns = useMemo(() => {
    const m = new THREE.InstancedMesh(CROWN, crownMat, Math.max(placed.length, 1));
    m.count = placed.length;
    m.frustumCulled = false;
    return m;
  }, [placed, crownMat]);
  useEffect(() => () => crowns.dispose(), [crowns]);
  useEffect(() => () => crownMat.dispose(), [crownMat]);
  useStormShade([trunks.material, crownMat], dayFactor(look), storm);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const s = storm.current.value;
    const amp = 0.05 + s * 0.2;
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      const sway = Math.sin(t * (1.1 + s) + p.phase);
      _e.set(amp * sway * 0.6, p.yaw, amp * Math.cos(t * 0.9 + p.phase * 1.3), 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(p.tip, _q, _s.set(p.size, p.size, p.size));
      crowns.setMatrixAt(i, _m);
    }
    crowns.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <primitive object={trunks.mesh} />
      <primitive object={crowns} />
    </group>
  );
});

const Greenery = memo(function Greenery({ scenery, look, uniforms, storm }) {
  const bushes = useInstances(
    uniforms,
    BLOB,
    scenery.bushes,
    (b) => boxMatrix(b.x, b.y + b.size * 0.3, b.z, b.size, b.size * 0.75, b.size),
    (b) => (b.tone < 0.4 ? '#4f8a45' : b.tone < 0.75 ? '#5f9a4c' : '#79a956'),
    { flatShading: true }
  );
  const hills = useInstances(
    uniforms,
    BLOB,
    scenery.hills,
    (h) => boxMatrix(h.x, -3, h.z, h.w, h.h, h.d),
    (h) => (h.tone < 0.5 ? '#5b8a4e' : '#6f9958'),
    { flatShading: true }
  );
  useStormShade([bushes.material, hills.material], dayFactor(look), storm);
  return (
    <group>
      <primitive object={bushes.mesh} />
      <primitive object={hills.mesh} />
    </group>
  );
});

// ── Boats ────────────────────────────────────────────────────

/** A small sailing boat's hull: pointed bow at +x, waterline at y = 0. */
const HULL = (() => {
  const shape = new THREE.Shape();
  shape.moveTo(-1.35, -0.46);
  shape.lineTo(0.4, -0.5);
  shape.quadraticCurveTo(1.25, -0.42, 1.55, 0);
  shape.quadraticCurveTo(1.25, 0.42, 0.4, 0.5);
  shape.lineTo(-1.35, 0.46);
  shape.quadraticCurveTo(-1.48, 0, -1.35, -0.46);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: 0.4,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.06,
    bevelSegments: 1,
    curveSegments: 6,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -0.14, 0);
  return g;
})();
/** The mainsail: a triangle aft of the mast. */
const SAIL = (() => {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.12);
  shape.lineTo(0, 1.42);
  shape.lineTo(-1.15, 0.12);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
})();
const LANTERN = new THREE.IcosahedronGeometry(0.11, 1);

const HULL_TOP = 0.32;
const MAST_H = 1.48;
/** Each part's place on the boat (boat origin: the waterline, centre). */
const PART_OFFSETS = {
  cabin: new THREE.Matrix4().compose(
    new THREE.Vector3(-0.38, HULL_TOP + 0.16, 0),
    new THREE.Quaternion(),
    new THREE.Vector3(0.95, 0.32, 0.68)
  ),
  mast: new THREE.Matrix4().compose(
    new THREE.Vector3(0.34, HULL_TOP + MAST_H / 2, 0),
    new THREE.Quaternion(),
    new THREE.Vector3(0.07, MAST_H, 0.07)
  ),
  sail: new THREE.Matrix4().makeTranslation(0.3, HULL_TOP, 0),
  lantern: new THREE.Matrix4().makeTranslation(0.34, HULL_TOP + MAST_H + 0.08, 0),
};
const HULL_COLORS = ['#f4f1ea', '#2f6f8f', '#c8553d', '#f0c04f', '#3a8f7a', '#e9e2d4'];
const SAIL_COLORS = ['#fff8ec', '#ffd3a1', '#cfe6ff', '#ffc9c3', '#e3f6cf', '#fff1ad'];

const AMBER = new THREE.Color('#ffb020');
const RED = new THREE.Color('#ff3b30');
const WARM = new THREE.Color('#ffd79a');
const UNLIT = new THREE.Color('#4a4038');

/**
 * One boat per live session, moored at a sticky slot, sailing in on arrival
 * and out once the session ends. Every part is one instanced mesh; the click
 * targets are invisible boxes that follow the boats.
 */
function Boats({ layout, office, events, look, uniforms, storm, onSelect, slotsOut }) {
  const slots = useRef(new Map());
  const endedAt = useRef(new Map());

  // Sessions (ended ones too, so they keep their berth while sailing off).
  const sessions = liveSessions(office, { ended: true });
  const signature = sessions.map((s) => `${s.pid}:${s.state}`).join(',');
  const arrivals = events
    .filter((e) => e.type === 'arrived')
    .map((e) => `${e.pid}@${e.at}`)
    .join(',');
  const boats = useMemo(() => {
    slots.current = stickySlots(
      slots.current,
      sessions.map((s) => s.pid),
      MOORINGS
    );
    slotsOut.current = slots.current;
    const arrivedAt = new Map();
    for (const e of events) if (e.type === 'arrived') arrivedAt.set(e.pid, e.at);
    return sessions
      .filter((s) => slots.current.has(s.pid))
      .map((s) => {
        const slot = slots.current.get(s.pid);
        return {
          pid: s.pid,
          state: s.state,
          slot,
          mooring: layout.moorings[slot],
          arrivedAt: arrivedAt.get(s.pid) ?? 0,
          hull: HULL_COLORS[slot % HULL_COLORS.length],
          sail: SAIL_COLORS[(slot * 5 + 2) % SAIL_COLORS.length],
          phase: slot * 1.7,
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, arrivals, layout]);

  // A departure starts the first time its session is seen ended.
  useEffect(() => {
    const now = Date.now();
    const present = new Set(boats.map((b) => b.pid));
    for (const b of boats)
      if (b.state === 'ended' && !endedAt.current.has(b.pid))
        endedAt.current.set(b.pid, now);
    for (const pid of endedAt.current.keys())
      if (!present.has(pid)) endedAt.current.delete(pid);
  }, [boats]);

  const solid = useMemo(
    () => exteriorMaterial(uniforms, { roughness: 0.55, flatShading: true }),
    [uniforms]
  );
  const sailMat = useMemo(
    () => exteriorMaterial(uniforms, { roughness: 0.9, side: THREE.DoubleSide }),
    [uniforms]
  );
  const lanternMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
    []
  );
  const meshes = useMemo(() => {
    const make = (geometry, material) => {
      const m = new THREE.InstancedMesh(geometry, material, MOORINGS);
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      return m;
    };
    return {
      hull: make(HULL, solid),
      cabin: make(BOX, solid),
      mast: make(BOX, solid),
      sail: make(SAIL, sailMat),
      lantern: make(LANTERN, lanternMat),
    };
  }, [solid, sailMat, lanternMat]);
  useEffect(
    () => () => {
      for (const m of Object.values(meshes)) m.dispose();
    },
    [meshes]
  );
  useEffect(
    () => () => {
      solid.dispose();
      sailMat.dispose();
      lanternMat.dispose();
    },
    [solid, sailMat, lanternMat]
  );

  // Colours change only when the fleet does.
  useLayoutEffect(() => {
    boats.forEach((b, i) => {
      meshes.hull.setColorAt(i, _c.set(b.hull));
      meshes.cabin.setColorAt(i, _c.set('#f6f2e8'));
      meshes.mast.setColorAt(i, _c.set('#5b4532'));
      meshes.sail.setColorAt(i, _c.set(b.sail));
      meshes.lantern.setColorAt(i, UNLIT);
    });
    for (const m of Object.values(meshes)) {
      m.count = boats.length;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }, [boats, meshes]);
  useLayoutEffect(() => {
    const k = 0.3 + 0.7 * look.day;
    solid.color.setScalar(k);
    sailMat.color.setScalar(k);
  }, [look, solid, sailMat]);

  const night = look.windows;
  const hits = useRef([]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const now = Date.now();
    const s = storm.current.value;
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      const m = b.mooring;
      let at;
      const left = endedAt.current.get(b.pid);
      const inFor = (now - b.arrivedAt) / 1000;
      if (left !== undefined) {
        const u = Math.min(1, (now - left) / 1000 / SAIL_OUT_S);
        at = sailOut(m, u * u);
      } else if (b.arrivedAt && inFor < SAIL_IN_S) {
        const u = inFor / SAIL_IN_S;
        at = sailIn(m, 1 - (1 - u) * (1 - u));
      } else {
        at = null;
      }
      const x = at ? at.x : m.x;
      const z = at ? at.z : m.z;
      const yaw = at ? at.yaw : 0.04 * Math.sin(t * 0.3 + b.phase);
      const bob = (0.05 + s * 0.12) * Math.sin(t * 1.4 + b.phase);
      const roll = (0.035 + s * 0.09) * Math.sin(t * 1.1 + b.phase * 1.7);
      const pitch = (0.02 + s * 0.05) * Math.sin(t * 0.9 + b.phase);
      _e.set(roll, yaw, pitch, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_p.set(x, SEA_Y + bob, z), _q, _s.set(1, 1, 1));
      meshes.hull.setMatrixAt(i, _m);
      meshes.cabin.setMatrixAt(i, _m2.multiplyMatrices(_m, PART_OFFSETS.cabin));
      meshes.mast.setMatrixAt(i, _m2.multiplyMatrices(_m, PART_OFFSETS.mast));
      meshes.sail.setMatrixAt(i, _m2.multiplyMatrices(_m, PART_OFFSETS.sail));
      meshes.lantern.setMatrixAt(i, _m2.multiplyMatrices(_m, PART_OFFSETS.lantern));

      // The lantern says how its agent is doing.
      if (b.state === 'waiting_on_user') _c2.copy(Math.sin(t * 6) > -0.2 ? AMBER : UNLIT);
      else if (b.state === 'error')
        _c2.copy(RED).multiplyScalar(0.7 + 0.3 * Math.sin(t * 4));
      else _c2.copy(UNLIT).lerp(WARM, night);
      meshes.lantern.setColorAt(i, _c2);

      const hit = hits.current[i];
      if (hit) {
        hit.position.set(x, SEA_Y + 0.6, z);
        hit.rotation.set(0, yaw, 0);
      }
    }
    for (const mesh of Object.values(meshes)) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.boundingSphere = null;
    }
    if (meshes.lantern.instanceColor) meshes.lantern.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      {Object.entries(meshes).map(([key, mesh]) => (
        <primitive key={key} object={mesh} />
      ))}
      {boats.map((b, i) => (
        <Clickable
          key={b.pid}
          pid={b.pid}
          onSelect={onSelect}
          ref={(g) => {
            hits.current[i] = g;
          }}
        >
          <mesh visible={false}>
            <boxGeometry args={[3.3, 2.6, 1.6]} />
          </mesh>
        </Clickable>
      ))}
    </group>
  );
}

// ── Dolphins ─────────────────────────────────────────────────

const LEAP_S = 2.3;
const MAX_DOLPHINS = 3;
const FIN = (() => {
  const g = new THREE.ConeGeometry(0.16, 0.42, 4);
  g.rotateZ(-0.5);
  g.translate(-0.1, 0.3, 0);
  return g;
})();
const RING = (() => {
  const g = new THREE.TorusGeometry(1, 0.07, 4, 20);
  g.rotateX(Math.PI / 2);
  return g;
})();

/** A dolphin leaps beside the boat of every agent that just finished its turn. */
function Dolphins({ layout, events, look, uniforms, slots }) {
  const leaps = useMemo(
    () => events.filter((e) => e.type === 'finished').slice(-MAX_DOLPHINS),
    [events]
  );
  const body = useMemo(
    () =>
      exteriorMaterial(uniforms, {
        color: '#5d7488',
        roughness: 0.35,
        flatShading: true,
      }),
    [uniforms]
  );
  const splashMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({ color: '#f2fbff', transparent: true, opacity: 0.8 }),
    []
  );
  const meshes = useMemo(() => {
    const make = (g, mat, n) => {
      const m = new THREE.InstancedMesh(g, mat, n);
      m.count = 0;
      m.frustumCulled = false;
      return m;
    };
    return {
      body: make(BLOB, body, MAX_DOLPHINS),
      fin: make(FIN, body, MAX_DOLPHINS),
      splash: make(RING, splashMat, MAX_DOLPHINS * 2),
    };
  }, [body, splashMat]);
  useEffect(
    () => () => {
      for (const m of Object.values(meshes)) m.dispose();
      body.dispose();
      splashMat.dispose();
    },
    [meshes, body, splashMat]
  );
  useLayoutEffect(() => {
    body.color.set('#5d7488').multiplyScalar(0.3 + 0.7 * look.day);
  }, [look, body]);

  useFrame(() => {
    const now = Date.now();
    let n = 0;
    let rings = 0;
    for (let lane = 0; lane < leaps.length; lane++) {
      const e = leaps[lane];
      const age = (now - e.at) / 1000;
      if (age < 0 || age > LEAP_S + 0.8) continue;
      const spot = leapSpot(layout, slots.current.get(e.pid), lane);
      const sx = spot.x;
      const sz = spot.z;
      const p = Math.min(1, age / LEAP_S);
      if (age <= LEAP_S) {
        const x = sx + (p - 0.5) * 7;
        const y = SEA_Y - 0.55 + Math.sin(p * Math.PI) * 1.9;
        _e.set(0, 0, Math.cos(p * Math.PI) * 0.95, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p.set(x, y, sz), _q, _s.set(1.15, 0.34, 0.38));
        meshes.body.setMatrixAt(n, _m);
        _m.compose(_p.set(x, y, sz), _q, _s.set(1, 1, 1));
        meshes.fin.setMatrixAt(n, _m);
        n++;
      }
      // Splashes where it leaves the water and where it dives back in.
      for (const [start, x] of [
        [0, sx - 3.3],
        [0.82, sx + 3.3],
      ]) {
        const a = (age - start * LEAP_S) / 0.8;
        if (a < 0 || a > 1) continue;
        _m.compose(
          _p.set(x, SEA_Y + 0.05 - a * 0.1, sz),
          _q.identity(),
          _s.set(0.3 + a * 1.4, 1, 0.3 + a * 1.4)
        );
        meshes.splash.setMatrixAt(rings++, _m);
      }
    }
    meshes.body.count = n;
    meshes.fin.count = n;
    meshes.splash.count = rings;
    // Nothing playing: no draw calls at all.
    meshes.body.visible = meshes.fin.visible = n > 0;
    meshes.splash.visible = rings > 0;
    meshes.body.instanceMatrix.needsUpdate = true;
    meshes.fin.instanceMatrix.needsUpdate = true;
    meshes.splash.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      {Object.entries(meshes).map(([key, mesh]) => (
        <primitive key={key} object={mesh} />
      ))}
    </group>
  );
}

// ── Sky life: clouds, rain, gulls ────────────────────────────

const CLOUD_FAIR = new THREE.Color('#ffffff');
const CLOUD_SQUALL = new THREE.Color('#4f5862');

/** Fair-weather clouds behind the island, and the squall that joins them. */
const Clouds = memo(function Clouds({ layout, look, storm, kind }) {
  const { room } = layout;
  const puffs = useMemo(() => {
    const rand = rng(kind === 'antigravity' ? 41 : 31);
    const list = [];
    for (let i = 0; i < 12; i++) {
      const squall = i >= 6;
      const behind = i % 2 === 0;
      // Behind the back wall, or beyond the left wall — never over the room,
      // and with room to spare for the puffs' spread and a squall's growth.
      // The squall hangs low just behind the pavilion, where the frame shows
      // it over the palms; fair-weather clouds drift further off.
      const x = behind
        ? room.x0 - 25 + rand() * Math.max(4, room.x1 - room.x0 - 5)
        : room.x0 - 32 - rand() * 40;
      const z = behind
        ? room.z0 - (squall ? 9 : 32) - rand() * (squall ? 10 : 40)
        : room.z0 - 20 + rand() * Math.max(4, room.z1 - room.z0 - 2);
      const y = squall ? 5.5 + rand() * 3 : 13 + rand() * 9;
      const size = squall ? 4.5 + rand() * 3 : 3 + rand() * 2.5;
      for (let k = 0; k < 4; k++)
        list.push({
          x: x + (k - 1.5) * size * 0.75,
          y: y + (k % 2) * size * 0.25,
          z: z + (rand() - 0.5) * size,
          r: size * (0.7 + rand() * 0.45),
          squall,
          phase: rand() * 6,
        });
    }
    return list;
  }, [room.x0, room.x1, room.z0, room.z1, kind]);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        roughness: 1,
        flatShading: true,
        transparent: true,
        opacity: 0.92,
      }),
    []
  );
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(BLOB, material, puffs.length);
    m.frustumCulled = false;
    return m;
  }, [puffs, material]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => () => material.dispose(), [material]);

  const night = 1 - look.day;
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const s = storm.current.value;
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i];
      const grow = p.squall ? s : 1 + s * 0.35;
      const r = p.r * grow;
      _m.compose(
        _p.set(p.x + Math.sin(t * 0.05 + p.phase) * 3, p.y, p.z),
        _q.identity(),
        _s.set(r, r * 0.55, r * 0.8)
      );
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    material.color
      .copy(CLOUD_FAIR)
      .lerp(CLOUD_SQUALL, s * 0.85)
      .multiplyScalar(1 - night * 0.75);
  });
  return <primitive object={mesh} />;
});

const RAIN_COUNT = 1600;

/** Rain while a storm blows: streaks falling in the shader, kept off the room. */
const Rain = memo(function Rain({ layout, storm }) {
  const geometry = useMemo(() => {
    const drops = rainDrops(layout, RAIN_COUNT);
    const g = new THREE.BufferGeometry();
    const position = new Float32Array(RAIN_COUNT * 2 * 3);
    const span = new Float32Array(RAIN_COUNT * 2 * 4);
    const tail = new Float32Array(RAIN_COUNT * 2);
    drops.forEach(([x, z, top, bottom], i) => {
      for (let k = 0; k < 2; k++) {
        const v = i * 2 + k;
        position.set([x, top, z], v * 3);
        span.set([x, z, top, bottom + ((i * 7919) % 97) / 97], v * 4);
        tail[v] = k;
      }
    });
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('aSpan', new THREE.BufferAttribute(span, 4));
    g.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));
    return g;
  }, [layout]);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        fog: true,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uTime: { value: 0 },
            uOpacity: { value: 0 },
            uColor: { value: new THREE.Color('#d4dde6') },
          },
        ]),
        vertexShader: /* glsl */ `
          attribute vec4 aSpan;
          attribute float aTail;
          uniform float uTime;
          varying float vTail;
          #include <fog_pars_vertex>
          void main() {
            float range = aSpan.z - aSpan.w;
            float seed = fract( aSpan.x * 0.137 + aSpan.y * 0.311 );
            float y = aSpan.z - mod( uTime * 16.0 + seed * range, range );
            vec3 p = vec3( aSpan.x - aTail * 0.22, y + aTail * 1.25, aSpan.y - aTail * 0.15 );
            vTail = aTail;
            vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uOpacity;
          uniform vec3 uColor;
          varying float vTail;
          #include <fog_pars_fragment>
          void main() {
            gl_FragColor = vec4( uColor, uOpacity * ( 1.0 - vTail * 0.7 ) );
            #include <fog_fragment>
          }
        `,
      }),
    []
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  const lines = useRef(null);
  useFrame(({ clock }) => {
    const s = storm.current.value;
    material.uniforms.uTime.value = clock.elapsedTime;
    material.uniforms.uOpacity.value = s * 0.7;
    if (lines.current) lines.current.visible = s > 0.02;
  });
  return (
    <lineSegments
      ref={lines}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      visible={false}
    />
  );
});

/** A V of wings, flapped by squashing it. */
const GULL = (() => {
  const g = new THREE.BufferGeometry();
  // Two wings from the body (origin) out to tips raised at ±z.
  const v = [
    0, 0, 0, -0.18, 0.04, 0, 0.05, 0.18, 0.95, 0, 0, 0, 0.05, 0.18, -0.95, -0.18, 0.04, 0,
  ];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
})();

/** Gulls circling high over the beach behind the pavilion. */
const Gulls = memo(function Gulls({ layout, look }) {
  const { room } = layout;
  const birds = useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) => ({
        cx: room.x0 - 13 + (i % 2) * 3,
        cz: room.z0 - 12 + (i % 3) * 2,
        r: 6 + i * 0.7,
        y: 9 + (i % 3) * 1.4,
        speed: 0.22 + i * 0.03,
        phase: i * 1.1,
      })),
    [room.x0, room.z0]
  );
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#f7f7f2', side: THREE.DoubleSide }),
    []
  );
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(GULL, material, birds.length);
    m.frustumCulled = false;
    return m;
  }, [birds, material]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => () => material.dispose(), [material]);
  useLayoutEffect(() => {
    material.color.set('#f7f7f2').multiplyScalar(0.25 + 0.75 * look.day);
  }, [look, material]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    for (let i = 0; i < birds.length; i++) {
      const b = birds[i];
      const a = t * b.speed + b.phase;
      const flap = 0.55 + 0.45 * Math.sin(t * 7 + b.phase * 3);
      _e.set(0, -a, 0.25, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(
        _p.set(
          b.cx + Math.cos(a) * b.r,
          b.y + Math.sin(a * 2) * 0.4,
          b.cz + Math.sin(a) * b.r
        ),
        _q,
        _s.set(0.6, 0.6 * flap, 0.6)
      );
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
});

// ── The island ───────────────────────────────────────────────

/** See ./index.js for the props every environment receives. */
export const Island = memo(function Island({
  plan,
  kind,
  look,
  office,
  events,
  mood,
  onSelect,
}) {
  const invalidate = useThree((s) => s.invalidate);
  const { minX, maxX, minZ, maxZ } = plan;
  const layout = useMemo(
    () => islandLayout({ minX, maxX, minZ, maxZ }),
    [minX, maxX, minZ, maxZ]
  );
  const scenery = useMemo(() => islandScenery(layout, seedFor(kind)), [layout, kind]);
  const uniforms = useMemo(() => makeExteriorUniforms({ haze: 0.1, hazeDepth: 6 }), []);
  const storm = useStorm(mood);
  const slots = useRef(new Map());

  return (
    <group>
      <Atmosphere look={look} invalidate={invalidate} />
      <Ground layout={layout} look={look} uniforms={uniforms} storm={storm} />
      <Sea layout={layout} look={look} storm={storm} />
      <Deck layout={layout} look={look} uniforms={uniforms} />
      <Palms scenery={scenery} look={look} uniforms={uniforms} storm={storm} />
      <Greenery scenery={scenery} look={look} uniforms={uniforms} storm={storm} />
      <Boats
        layout={layout}
        office={office}
        events={events}
        look={look}
        uniforms={uniforms}
        storm={storm}
        onSelect={onSelect}
        slotsOut={slots}
      />
      <Dolphins
        layout={layout}
        events={events}
        look={look}
        uniforms={uniforms}
        slots={slots}
      />
      <Clouds layout={layout} look={look} storm={storm} kind={kind} />
      <Rain layout={layout} storm={storm} />
      <Gulls layout={layout} look={look} />
    </group>
  );
});
