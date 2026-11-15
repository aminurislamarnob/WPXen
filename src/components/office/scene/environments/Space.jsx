import { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { stickySlots } from '../../../../lib/office/agentEvents.js';
import { teamColor } from '../../../../lib/office/scene/theme.js';
import {
  ARRIVE_S,
  HULL_BOTTOM,
  SLAB_BOTTOM,
  arrivalPose,
  beacon,
  departurePose,
  dockedAt,
  dockingPorts,
  earthPlacement,
  earthSun,
  shootingStarPath,
  stationFrame,
} from '../../../../lib/office/scene/space.js';
import { Atmosphere, BOX, Clickable, eventAge, liveSessions } from './common.jsx';

// ── Space station ────────────────────────────────────────────
// The room as a module of an orbital station: a hull under its floor with
// docking ports on the two faces the camera sees, a habitat module, a node,
// a truss with solar wings and radiators reaching out behind and to the left,
// and the Earth far below, turning in step with the viewer's local time (noon
// lights the hemisphere under the station, midnight shows its city lights).
//
// It reacts to the agents: each live session's shuttle sits at its own
// docking port (sticky, so nobody swaps berths); an arrival flies one in, a
// departure backs it out, turns it and burns away; a finished turn sends a
// shooting star across the sky behind; an agent in error lights its shuttle's
// beacon red, one waiting on you blinks it amber. Clicking a shuttle focuses
// its agent.
//
// Layout and choreography are pure (lib/office/scene/space.js, tested): ports
// and flight paths stay below the office floor on the camera's side, and the
// Earth is placed so it can never cover the station from any camera angle.
// Budget: ~19 draw calls — every repeat is instanced, the shuttles' hit boxes
// draw nothing, and nothing out here enters the shadow map.

/** No air, no haze: fog that starts past everything in the scene. */
const NO_FOG_NEAR = 4000;
const NO_FOG_FAR = 5000;
/** The Earth's surface drifts by at this rate (radians per second) — orbital motion. */
const EARTH_SPIN = 0.012;
/** Seconds a shooting star takes to cross. */
const STAR_S = 1.15;
/** Shooting stars on screen at once. */
const STAR_POOL = 3;

// ── Textures (drawn once per page, on a canvas) ──────────────

let hullMaps = null;
/** Hull plating: seams, a few service panels, and two rows of portholes (with their own glow map). */
function hullTextures() {
  if (hullMaps) return hullMaps;
  const size = 256;
  const make = (draw) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    draw(canvas.getContext('2d'));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    return tex;
  };
  // Portholes sit 75% up each 4-unit tile, which (from the keel at -6.4)
  // puts one row at -3.4: under the docked shuttles, clear of their ports.
  const holes = (ctx, fill) => {
    ctx.fillStyle = fill;
    for (let x = 16; x < size; x += 32) {
      ctx.beginPath();
      ctx.arc(x, size * 0.25, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  const map = make((ctx) => {
    ctx.fillStyle = '#e3e6eb';
    ctx.fillRect(0, 0, size, size);
    let seed = 7;
    const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 0; y < size; y += 64)
      for (let x = 0; x < size; x += 64) {
        const t = r();
        ctx.fillStyle = t < 0.18 ? '#d2d7de' : t < 0.26 ? '#eef0f3' : '#e3e6eb';
        ctx.fillRect(x + 1, y + 1, 62, 62);
        if (t > 0.9) {
          ctx.fillStyle = '#8a95a3';
          ctx.fillRect(x + 14, y + 20, 36, 10);
        }
      }
    ctx.strokeStyle = '#b9c0c9';
    ctx.lineWidth = 2;
    for (let i = 0; i <= size; i += 64) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, size);
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
      ctx.stroke();
    }
    ctx.fillStyle = '#c9ced6';
    ctx.fillRect(0, size * 0.25 - 12, size, 24);
    holes(ctx, '#1b2533');
  });
  const glow = make((ctx) => {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, size);
    holes(ctx, '#ffd9a0');
  });
  glow.colorSpace = THREE.SRGBColorSpace;
  hullMaps = { map, glow };
  return hullMaps;
}

let solarMap = null;
/** Solar blanket: dark blue cells, silver grid, gold edge strips. */
function solarTexture() {
  if (solarMap) return solarMap;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1b2f63';
  ctx.fillRect(0, 0, 128, 256);
  ctx.fillStyle = '#24407f';
  for (let y = 4; y < 256; y += 16)
    for (let x = 4; x < 128; x += 16) ctx.fillRect(x, y, 11, 11);
  ctx.fillStyle = '#c9a54a';
  ctx.fillRect(0, 0, 128, 3);
  ctx.fillRect(0, 253, 128, 3);
  ctx.fillStyle = '#9aa5b5';
  ctx.fillRect(62, 0, 4, 256);
  solarMap = new THREE.CanvasTexture(canvas);
  solarMap.colorSpace = THREE.SRGBColorSpace;
  solarMap.anisotropy = 8;
  return solarMap;
}

/** A box whose UVs repeat every `tile` units on every face, so plating keeps one scale. */
function tiledBox(w, h, d, tile) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // BoxGeometry faces: ±x (d × h), ±y (w × d), ±z (w × h); four vertices each.
  const dims = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++)
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / tile, (uv.getY(i) * dims[f][1]) / tile);
    }
  return g;
}

// ── Shared scratch (no allocation in frame loops) ────────────

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function compose(x, y, z, yaw, sx = 1, sy = 1, sz = 1) {
  _q.setFromEuler(_e.set(0, yaw, 0));
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** An InstancedMesh owned by the component: created once per capacity, disposed with it. */
function useInstanced(geometry, material, count) {
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < m.count; i++) m.setMatrixAt(i, ZERO);
    m.frustumCulled = false;
    return m;
  }, [geometry, material, count]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  return mesh;
}

// ── The hull under the room ──────────────────────────────────

function Hull({ frame, ports }) {
  const { map, glow } = hullTextures();
  const h = SLAB_BOTTOM - HULL_BOTTOM;
  const hull = useMemo(
    () => tiledBox(frame.w - 0.06, h, frame.d - 0.06, 4),
    [frame.w, frame.d, h]
  );
  useEffect(() => () => hull.dispose(), [hull]);
  const tubes = useMemo(() => {
    const geom = new THREE.CylinderGeometry(0.3, 0.34, 0.8, 16);
    const mat = new THREE.MeshStandardMaterial({
      color: '#b3b9c2',
      roughness: 0.45,
      metalness: 0.45,
    });
    const m = new THREE.InstancedMesh(geom, mat, Math.max(1, ports.length * 2));
    ports.forEach((port, i) => {
      _a.set(port.out[0], 0, port.out[2]);
      _q.setFromUnitVectors(_up, _a);
      // the tube, and a wider collar where the shuttle mates
      m.setMatrixAt(
        i * 2,
        _m.compose(
          _p.set(port.x + port.out[0] * 0.4, port.y, port.z + port.out[2] * 0.4),
          _q,
          _s.set(1, 1, 1)
        )
      );
      m.setMatrixAt(
        i * 2 + 1,
        _m.compose(
          _p.set(port.x + port.out[0] * 0.78, port.y, port.z + port.out[2] * 0.78),
          _q,
          _s.set(1.3, 0.05, 1.3)
        )
      );
    });
    m.count = ports.length * 2;
    m.frustumCulled = false;
    return m;
  }, [ports]);
  useEffect(
    () => () => {
      tubes.geometry.dispose();
      tubes.material.dispose();
      tubes.dispose();
    },
    [tubes]
  );
  return (
    <group>
      <mesh
        geometry={hull}
        position={[frame.cx, (SLAB_BOTTOM + HULL_BOTTOM) / 2, frame.cz]}
      >
        <meshStandardMaterial
          map={map}
          emissiveMap={glow}
          emissive="#ffffff"
          emissiveIntensity={0.85}
          roughness={0.5}
          metalness={0.25}
        />
      </mesh>
      {/* dark deck band right under the slab: the module's structural ring */}
      <mesh position={[frame.cx, SLAB_BOTTOM - 0.28, frame.cz]}>
        <boxGeometry args={[frame.w + 0.12, 0.5, frame.d + 0.12]} />
        <meshStandardMaterial color="#4e5562" roughness={0.6} metalness={0.5} />
      </mesh>
      {/* keel: a narrower service bay below the hull */}
      <mesh position={[frame.cx, HULL_BOTTOM - 0.8, frame.cz]}>
        <boxGeometry args={[frame.w - 3, 1.6, frame.d - 3]} />
        <meshStandardMaterial color="#6b7380" roughness={0.6} metalness={0.45} />
      </mesh>
      <primitive object={tubes} />
    </group>
  );
}

// ── The rest of the station: behind and left only ────────────

/** Module axis height, and the lengths of the habitat (left) and node (behind) modules. */
const MOD_Y = -1.3;
const LEFT_LEN = 22;
const BACK_LEN = 12;

function Structure({ frame }) {
  // Instanced boxes: truss chords and braces, masts, radiators.
  const parts = useMemo(() => {
    const list = [];
    const trussZ = frame.z0 - 14;
    const trussY = -0.6;
    const x0 = frame.x0 - 38;
    const x1 = frame.x1 - 2;
    const len = x1 - x0;
    for (const [dy, dz] of [
      [-0.6, -0.6],
      [-0.6, 0.6],
      [0.6, -0.6],
      [0.6, 0.6],
    ])
      list.push({
        c: [x0 + len / 2, trussY + dy, trussZ + dz],
        s: [len, 0.14, 0.14],
        col: '#b9bfc8',
      });
    for (let x = x0 + 1; x < x1; x += 2.4) {
      list.push({ c: [x, trussY, trussZ - 0.6], s: [0.1, 1.3, 0.1], col: '#a3aab4' });
      list.push({ c: [x, trussY, trussZ + 0.6], s: [0.1, 1.3, 0.1], col: '#a3aab4' });
      list.push({ c: [x, trussY + 0.6, trussZ], s: [0.1, 0.1, 1.3], col: '#a3aab4' });
    }
    // Masts up to the solar wings.
    for (const mx of [frame.x0 - 7, frame.x0 - 17, frame.x0 - 27])
      list.push({ c: [mx, trussY + 4.5, trussZ], s: [0.22, 9, 0.22], col: '#c7ccd4' });
    // Radiators: white wings reaching back from the habitat module (never
    // forward, past the room's front edge), on a strut from the module's flank.
    for (let i = 0; i < 3; i++) {
      const rx = frame.x0 - 6 - i * 5;
      list.push({
        c: [rx, -0.9, frame.cz - 2.4 - 0.6],
        s: [0.16, 0.16, 1.2],
        col: '#a3aab4',
      });
      list.push({ c: [rx, -0.9, frame.cz - 3.6 - 3], s: [3.6, 0.07, 6], col: '#f3f4f6' });
    }
    return list;
  }, [frame]);
  const boxes = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.35 });
    const m = new THREE.InstancedMesh(BOX, mat, parts.length);
    const c = new THREE.Color();
    parts.forEach((p, i) => {
      m.setMatrixAt(i, _m.compose(_p.set(...p.c), _q.identity(), _s.set(...p.s)));
      m.setColorAt(i, c.set(p.col));
    });
    m.frustumCulled = false;
    return m;
  }, [parts]);
  useEffect(
    () => () => {
      boxes.material.dispose();
      boxes.dispose();
    },
    [boxes]
  );

  // Solar wings: two blankets per mast, tilted toward the sun side.
  const wings = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      map: solarTexture(),
      roughness: 0.35,
      metalness: 0.55,
      side: THREE.DoubleSide,
    });
    const geom = new THREE.PlaneGeometry(1, 1);
    const masts = [frame.x0 - 7, frame.x0 - 17, frame.x0 - 27];
    const m = new THREE.InstancedMesh(geom, mat, masts.length * 2);
    const trussZ = frame.z0 - 14;
    masts.forEach((mx, i) => {
      for (const side of [-1, 1]) {
        _q.setFromEuler(_e.set(-0.32, 0, 0));
        m.setMatrixAt(
          i * 2 + (side + 1) / 2,
          _m.compose(_p.set(mx + side * 2.05, 5.6, trussZ - 0.9), _q, _s.set(3.6, 11, 1))
        );
      }
    });
    m.frustumCulled = false;
    return m;
  }, [frame]);
  useEffect(
    () => () => {
      wings.geometry.dispose();
      wings.material.dispose();
      wings.dispose();
    },
    [wings]
  );

  // Ribs around both modules: one instanced ring mesh.
  const ribs = useMemo(() => {
    const geom = new THREE.CylinderGeometry(2.32, 2.32, 0.28, 28, 1, true);
    const mat = new THREE.MeshStandardMaterial({
      color: '#b8bec7',
      roughness: 0.45,
      metalness: 0.5,
      side: THREE.DoubleSide,
    });
    const spots = [];
    for (let i = 1; i < 6; i++)
      spots.push({
        p: [frame.x0 - 0.2 - (LEFT_LEN * i) / 6, MOD_Y, frame.cz],
        r: [0, 0, Math.PI / 2],
      });
    for (let i = 1; i < 4; i++)
      spots.push({
        p: [frame.cx - 4, MOD_Y, frame.z0 - 0.2 - (BACK_LEN * i) / 4],
        r: [Math.PI / 2, 0, 0],
      });
    const m = new THREE.InstancedMesh(geom, mat, spots.length);
    spots.forEach((sp, i) => {
      _q.setFromEuler(_e.set(...sp.r));
      m.setMatrixAt(i, _m.compose(_p.set(...sp.p), _q, _s.set(1, 1, 1)));
    });
    m.frustumCulled = false;
    return m;
  }, [frame]);
  useEffect(
    () => () => {
      ribs.geometry.dispose();
      ribs.material.dispose();
      ribs.dispose();
    },
    [ribs]
  );
  return (
    <group>
      {/* habitat module off the left wall */}
      <mesh
        position={[frame.x0 - LEFT_LEN / 2 - 0.2, MOD_Y, frame.cz]}
        rotation={[0, 0, Math.PI / 2]}
      >
        <cylinderGeometry args={[2.2, 2.2, LEFT_LEN, 28]} />
        <meshStandardMaterial color="#e6e9ee" roughness={0.5} metalness={0.25} />
      </mesh>
      {/* node module behind the back wall, joining the truss */}
      <mesh
        position={[frame.cx - 4, MOD_Y, frame.z0 - BACK_LEN / 2 - 0.2]}
        rotation={[Math.PI / 2, 0, 0]}
      >
        <cylinderGeometry args={[2.2, 2.2, BACK_LEN, 28]} />
        <meshStandardMaterial color="#dfe3e9" roughness={0.5} metalness={0.25} />
      </mesh>
      {/* gold-foiled ring where the habitat meets the room */}
      <mesh position={[frame.x0 - 0.5, MOD_Y, frame.cz]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[2.35, 2.35, 0.6, 28]} />
        <meshStandardMaterial color="#c99a3e" roughness={0.35} metalness={0.7} />
      </mesh>
      {/* comms dish on the node */}
      <group position={[frame.cx - 6, MOD_Y + 2.2, frame.z0 - 8]}>
        <mesh position={[0, 1.1, 0]}>
          <cylinderGeometry args={[0.08, 0.08, 2.2, 8]} />
          <meshStandardMaterial color="#b9bfc8" metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, 2.4, 0]} rotation={[-0.9, 0.6, 0]}>
          <sphereGeometry args={[1.5, 24, 8, 0, Math.PI * 2, 0, 0.62]} />
          <meshStandardMaterial
            color="#eef0f3"
            roughness={0.4}
            metalness={0.2}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
      <primitive object={boxes} />
      <primitive object={wings} />
      <primitive object={ribs} />
    </group>
  );
}

// ── Nav lights ───────────────────────────────────────────────

const NAV_GEOMETRY = new THREE.SphereGeometry(1, 10, 8);

function NavLights({ frame }) {
  const lights = useMemo(
    () => [
      // position, colour, period (s), phase, size
      {
        p: [frame.x1 + 0.1, HULL_BOTTOM + 0.4, frame.z1 + 0.1],
        col: '#3cff7a',
        per: 1.6,
        ph: 0,
        r: 0.16,
      },
      {
        p: [frame.x0 + 0.3, HULL_BOTTOM + 0.4, frame.z1 + 0.1],
        col: '#ff4040',
        per: 1.6,
        ph: 0.8,
        r: 0.16,
      },
      {
        p: [frame.x1 + 0.1, SLAB_BOTTOM - 0.6, frame.z0 + 0.4],
        col: '#ffffff',
        per: 2.2,
        ph: 0.3,
        r: 0.14,
      },
      {
        p: [frame.x0 - 7, 9.4, frame.z0 - 14],
        col: '#ff4040',
        per: 2.8,
        ph: 1.1,
        r: 0.2,
      },
      {
        p: [frame.x0 - 27, 9.4, frame.z0 - 14],
        col: '#ff4040',
        per: 2.8,
        ph: 2.2,
        r: 0.2,
      },
      {
        p: [frame.cx - 6, 3.6, frame.z0 - 8],
        col: '#ffffff',
        per: 1.9,
        ph: 0.5,
        r: 0.14,
      },
    ],
    [frame]
  );
  const mesh = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    const m = new THREE.InstancedMesh(NAV_GEOMETRY, mat, lights.length);
    const c = new THREE.Color();
    lights.forEach((l, i) => m.setColorAt(i, c.set(l.col).multiplyScalar(2)));
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    return m;
  }, [lights]);
  useEffect(
    () => () => {
      mesh.material.dispose();
      mesh.dispose();
    },
    [mesh]
  );
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      const on = (t + l.ph) % l.per < 0.22;
      mesh.setMatrixAt(i, on ? compose(l.p[0], l.p[1], l.p[2], 0, l.r, l.r, l.r) : ZERO);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

// ── The Earth ────────────────────────────────────────────────

const EARTH_VERTEX = /* glsl */ `
uniform float uSpin;
varying vec3 vNormalW;
varying vec3 vSurface;
void main() {
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  // The station orbits above the planet's top, so its poles are laid along the
  // horizon (world ±z) and the equator runs under the station — otherwise all
  // the camera sees is polar ice. The surface turns about that polar axis.
  vec3 n = vec3( normal.x, normal.z, normal.y );
  float c = cos( uSpin );
  float s = sin( uSpin );
  vSurface = vec3( c * n.x + s * n.z, n.y, -s * n.x + c * n.z );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const EARTH_FRAGMENT = /* glsl */ `
uniform vec3 uSun;
uniform float uSpin;
varying vec3 vNormalW;
varying vec3 vSurface;

float hash3( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float noise3( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( hash3( i ), hash3( i + vec3( 1, 0, 0 ) ), f.x ),
         mix( hash3( i + vec3( 0, 1, 0 ) ), hash3( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( hash3( i + vec3( 0, 0, 1 ) ), hash3( i + vec3( 1, 0, 1 ) ), f.x ),
         mix( hash3( i + vec3( 0, 1, 1 ) ), hash3( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
    f.z );
}
float fbm( vec3 p, int octaves ) {
  float a = 0.5;
  float s = 0.0;
  for ( int i = 0; i < 7; i++ ) {
    if ( i >= octaves ) break;
    s += a * noise3( p );
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 N = normalize( vNormalW );
  vec3 V = normalize( vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] ) );
  vec3 P = normalize( vSurface );
  // The station sees only a few degrees of the planet, so the terrain needs
  // detail at that scale: broad continents from a low octave, ragged coasts,
  // deserts and forests from fine ones.
  float continent = fbm( P * 1.6 + 9.0, 3 ) - 0.5;
  float h = fbm( P * 7.0 + vec3( 1.3, 5.4, 2.2 ), 7 ) + continent * 0.55;
  float land = smoothstep( 0.5, 0.515, h );
  float lat = abs( P.y );
  vec3 ocean = mix( vec3( 0.01, 0.05, 0.15 ), vec3( 0.03, 0.18, 0.32 ), smoothstep( 0.36, 0.5, h ) );
  float dry = smoothstep( 0.45, 0.62, fbm( P * 11.0 + 3.7, 5 ) );
  vec3 ground = mix( vec3( 0.09, 0.2, 0.07 ), vec3( 0.2, 0.3, 0.12 ), smoothstep( 0.52, 0.6, h ) );
  ground = mix( ground, vec3( 0.5, 0.42, 0.27 ), dry * 0.85 );
  vec3 surface = mix( ocean, ground, land );
  surface = mix( surface, vec3( 0.86, 0.9, 0.95 ), smoothstep( 0.82, 0.9, lat ) );
  // Weather: wispy systems drifting with the orbit.
  float cloud = smoothstep( 0.56, 0.78, fbm( P * 9.0 + vec3( uSpin * 0.7, 2.0, 7.0 ), 6 ) );

  float ndl = dot( N, uSun );
  float lit = max( ndl, 0.0 );
  float day = smoothstep( -0.1, 0.22, ndl );
  vec3 H = normalize( uSun + V );
  float glint = pow( max( dot( N, H ), 0.0 ), 70.0 ) * ( 1.0 - land ) * ( 1.0 - cloud );
  vec3 dayColor = mix( surface, vec3( 0.86, 0.89, 0.93 ), cloud * 0.8 ) * ( 0.04 + 0.95 * lit )
    + vec3( 1.0, 0.95, 0.85 ) * glint * 0.7;
  // Night side: city lights on land — metro regions, each a scatter of small
  // points of light — dimmed under cloud.
  float region = smoothstep( 0.52, 0.66, fbm( P * 18.0 + 4.0, 4 ) );
  float speck = smoothstep( 0.7, 0.9, noise3( P * 900.0 ) ) + 0.35 * smoothstep( 0.6, 0.8, noise3( P * 260.0 ) );
  float cities = land * region * speck * ( 1.0 - smoothstep( 0.66, 0.82, lat ) );
  vec3 nightColor = vec3( 0.006, 0.01, 0.022 ) + surface * 0.02 + cloud * 0.012
    + vec3( 1.0, 0.68, 0.32 ) * cities * 1.6 * ( 1.0 - cloud * 0.75 );
  vec3 color = mix( nightColor, dayColor, day );
  // Sunset band along the terminator.
  color += vec3( 0.55, 0.22, 0.06 ) * ( 1.0 - abs( ndl * 4.0 - 0.2 ) ) * step( abs( ndl ), 0.3 ) * 0.25;
  // Atmosphere: a thin blue rim, bright on the day side.
  float rim = pow( 1.0 - max( dot( N, V ), 0.0 ), 6.0 );
  color += vec3( 0.25, 0.5, 1.0 ) * rim * ( 0.05 + 0.55 * smoothstep( -0.25, 0.4, ndl ) );
  gl_FragColor = vec4( color, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uSun;
varying vec3 vNormalW;
varying vec3 vSurface;
void main() {
  vec3 N = normalize( vNormalW );
  vec3 V = normalize( vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] ) );
  // Back faces of a slightly larger sphere: strongest just outside the limb.
  float edge = smoothstep( 0.0, 0.14, abs( dot( N, V ) ) );
  float sun = smoothstep( -0.35, 0.45, dot( N, uSun ) );
  gl_FragColor = vec4( vec3( 0.3, 0.56, 1.0 ) * edge * ( 0.1 + 0.6 * sun ), 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function Earth({ target, hour }) {
  const earth = useMemo(() => earthPlacement(target), [target]);
  const uniforms = useMemo(
    () => ({ uSun: { value: new THREE.Vector3(0, 1, 0) }, uSpin: { value: 0 } }),
    []
  );
  const planet = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: EARTH_VERTEX,
        fragmentShader: EARTH_FRAGMENT,
      }),
    [uniforms]
  );
  const halo = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: EARTH_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        side: THREE.BackSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [uniforms]
  );
  useEffect(
    () => () => {
      planet.dispose();
      halo.dispose();
    },
    [planet, halo]
  );
  useEffect(() => {
    uniforms.uSun.value.set(...earthSun(earth, target, hour));
  }, [earth, target, hour, uniforms]);
  useFrame(({ clock }) => {
    // Offset so the station starts over a coastline rather than open ocean.
    uniforms.uSpin.value = 0.9 + clock.elapsedTime * EARTH_SPIN;
  });
  return (
    <group position={earth.center}>
      <mesh material={planet}>
        <sphereGeometry args={[earth.radius, 160, 96]} />
      </mesh>
      <mesh material={halo}>
        <sphereGeometry args={[earth.radius * 1.012, 128, 64]} />
      </mesh>
    </group>
  );
}

// ── Shooting stars on finished turns ─────────────────────────

const STAR_GEOMETRY = (() => {
  // Bright head at +y, fading to a point behind it.
  const g = new THREE.CylinderGeometry(0.09, 0, 1, 6, 1, true);
  g.translate(0, -0.5, 0);
  return g;
})();

function ShootingStars({ eventsRef, target }) {
  const mesh = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const m = new THREE.InstancedMesh(STAR_GEOMETRY, mat, STAR_POOL);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < STAR_POOL; i++) {
      m.setMatrixAt(i, ZERO);
      m.setColorAt(i, new THREE.Color(0, 0, 0));
    }
    m.frustumCulled = false;
    return m;
  }, []);
  useEffect(
    () => () => {
      mesh.material.dispose();
      mesh.dispose();
    },
    [mesh]
  );
  const paths = useRef(new Map());
  useFrame(() => {
    const now = Date.now();
    let slot = 0;
    const events = eventsRef.current;
    for (let i = events.length - 1; i >= 0 && slot < STAR_POOL; i--) {
      const ev = events[i];
      if (ev.type !== 'finished') continue;
      const u = eventAge(ev, now) / STAR_S;
      if (u < 0 || u > 1) continue;
      let path = paths.current.get(ev.id);
      if (!path) {
        path = shootingStarPath(target, ev.id);
        paths.current.set(ev.id, path);
      }
      _a.fromArray(path.from);
      _b.fromArray(path.to);
      _p.lerpVectors(_a, _b, u);
      _b.sub(_a).normalize();
      _q.setFromUnitVectors(_up, _b);
      const fade = Math.sin(Math.PI * u);
      mesh.setMatrixAt(
        slot,
        _m.compose(_p, _q, _s.set(1 + fade, 3.2 + 3 * fade, 1 + fade))
      );
      mesh.instanceColor.setXYZ(slot, 1.8 * fade, 1.9 * fade, 2.2 * fade);
      slot++;
    }
    for (; slot < STAR_POOL; slot++) mesh.setMatrixAt(slot, ZERO);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    if (paths.current.size > 24) paths.current.clear();
  });
  return <primitive object={mesh} />;
}

// ── Shuttles: one per agent ──────────────────────────────────

/** Shuttle parts in shuttle space (nose = +z, length 2.7). */
const PART = {
  body: new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)),
    new THREE.Vector3(1.2, 1, 0.78)
  ),
  canopy: new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0.26, 0.62),
    new THREE.Quaternion(),
    new THREE.Vector3(0.52, 0.14, 0.5)
  ),
  wings: new THREE.Matrix4().compose(
    new THREE.Vector3(0, -0.14, -0.35),
    new THREE.Quaternion(),
    new THREE.Vector3(2.3, 0.06, 0.95)
  ),
  fin: new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0.42, -0.95),
    new THREE.Quaternion(),
    new THREE.Vector3(0.06, 0.55, 0.62)
  ),
  engine: new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, -1.38),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)),
    new THREE.Vector3(1, 0.3, 1)
  ),
  flame: new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, -1.75),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
    new THREE.Vector3(1, 1, 1)
  ),
  beacon: new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0.44, -0.2),
    new THREE.Quaternion(),
    new THREE.Vector3(0.09, 0.09, 0.09)
  ),
  halo: new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0.44, -0.2),
    new THREE.Quaternion(),
    new THREE.Vector3(0.32, 0.32, 0.32)
  ),
};

const SHUTTLE_GEOMETRY = {
  body: new THREE.CapsuleGeometry(0.42, 1.8, 6, 14),
  engine: new THREE.CylinderGeometry(0.26, 0.2, 1, 12),
  flame: new THREE.ConeGeometry(0.2, 1, 10, 1, true),
  dot: new THREE.SphereGeometry(1, 10, 8),
};

const BEACON_OFF = new THREE.Color('#3a3f47');
/** Beacon colours, parsed once: the frame loop only copies them. */
const BEACON_COLORS = Object.fromEntries(
  ['#ff3b30', '#ffb020', '#e8f1ff'].map((hex) => [hex, new THREE.Color(hex)])
);
const _bc = new THREE.Color();

function Shuttles({ ports, entriesRef, eventsRef, entries, onSelect }) {
  const capacity = ports.length;
  const materials = useMemo(
    () => ({
      body: new THREE.MeshStandardMaterial({
        color: '#eef1f5',
        roughness: 0.38,
        metalness: 0.2,
      }),
      canopy: new THREE.MeshStandardMaterial({
        color: '#16233a',
        roughness: 0.15,
        metalness: 0.6,
      }),
      trim: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.25 }),
      engine: new THREE.MeshStandardMaterial({
        color: '#3b4049',
        roughness: 0.5,
        metalness: 0.7,
      }),
      flame: new THREE.MeshBasicMaterial({
        color: '#8fdcff',
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      beacon: new THREE.MeshBasicMaterial({ toneMapped: false }),
      halo: new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    }),
    []
  );
  useEffect(
    () => () => Object.values(materials).forEach((m) => m.dispose()),
    [materials]
  );

  const body = useInstanced(SHUTTLE_GEOMETRY.body, materials.body, capacity);
  const canopy = useInstanced(BOX, materials.canopy, capacity);
  const trim = useInstanced(BOX, materials.trim, capacity * 2);
  const engine = useInstanced(SHUTTLE_GEOMETRY.engine, materials.engine, capacity);
  const flame = useInstanced(SHUTTLE_GEOMETRY.flame, materials.flame, capacity);
  const beaconMesh = useInstanced(SHUTTLE_GEOMETRY.dot, materials.beacon, capacity);
  const halo = useInstanced(SHUTTLE_GEOMETRY.dot, materials.halo, capacity);
  // Every instance needs a colour slot before the first frame.
  useEffect(() => {
    for (let i = 0; i < capacity; i++) {
      beaconMesh.setColorAt(i, BEACON_OFF);
      halo.setColorAt(i, BEACON_OFF);
      trim.setColorAt(i * 2, BEACON_OFF);
      trim.setColorAt(i * 2 + 1, BEACON_OFF);
    }
  }, [beaconMesh, halo, trim, capacity]);

  const hitRefs = useRef([]);
  const all = useMemo(
    () => [body, canopy, trim, engine, flame, beaconMesh, halo],
    [body, canopy, trim, engine, flame, beaconMesh, halo]
  );
  const perShuttle = useMemo(
    () => [body, canopy, engine, flame, beaconMesh, halo],
    [body, canopy, engine, flame, beaconMesh, halo]
  );
  const coloured = useMemo(() => [trim, beaconMesh, halo], [trim, beaconMesh, halo]);
  const docked = useMemo(() => ports.map((p) => dockedAt(p)), [ports]);
  // Reused per-frame scratch: a pose and a beacon reading.
  const flight = useMemo(() => ({ x: 0, y: 0, z: 0, yaw: 0, thrust: 0 }), []);
  const light = useMemo(() => ({ color: '', on: false, glow: 0 }), []);

  useFrame(({ clock }) => {
    const now = Date.now();
    const time = clock.elapsedTime;
    const list = entriesRef.current;
    const events = eventsRef.current;
    for (let i = 0; i < capacity; i++) {
      const entry = list[i];
      let pose = null;
      if (entry) {
        const port = ports[entry.slot];
        if (entry.state === 'ended') {
          const left = lastEvent(events, 'left', entry.pid);
          pose = left ? departurePose(port, eventAge(left, now), flight) : null;
        } else {
          const came = lastEvent(events, 'arrived', entry.pid);
          const age = came ? eventAge(came, now) : Infinity;
          if (age < ARRIVE_S) pose = arrivalPose(port, age, flight);
          else {
            const at = docked[entry.slot];
            pose = flight;
            flight.x = at[0];
            flight.y = at[1];
            flight.z = at[2];
            flight.yaw = port.yaw;
            flight.thrust = 0;
          }
        }
      }
      const hit = hitRefs.current[i];
      if (!pose) {
        for (let k = 0; k < perShuttle.length; k++) perShuttle[k].setMatrixAt(i, ZERO);
        trim.setMatrixAt(i * 2, ZERO);
        trim.setMatrixAt(i * 2 + 1, ZERO);
        if (hit) hit.scale.setScalar(0);
        continue;
      }
      // A little station-keeping bob while docked or drifting.
      const bob = Math.sin(time * 1.3 + i * 1.7) * 0.03;
      const base = _m2.copy(compose(pose.x, pose.y + bob, pose.z, pose.yaw));
      body.setMatrixAt(i, _m.multiplyMatrices(base, PART.body));
      canopy.setMatrixAt(i, _m.multiplyMatrices(base, PART.canopy));
      trim.setMatrixAt(i * 2, _m.multiplyMatrices(base, PART.wings));
      trim.setMatrixAt(i * 2 + 1, _m.multiplyMatrices(base, PART.fin));
      trim.setColorAt(i * 2, entry.color);
      trim.setColorAt(i * 2 + 1, entry.color);
      engine.setMatrixAt(i, _m.multiplyMatrices(base, PART.engine));
      const thrust = pose.thrust * (0.85 + 0.15 * Math.sin(time * 40 + i));
      if (thrust > 0.02) {
        _m.multiplyMatrices(base, PART.flame);
        _m.scale(_s.set(thrust, 0.4 + 1.6 * thrust, thrust));
        flame.setMatrixAt(i, _m);
      } else flame.setMatrixAt(i, ZERO);
      const b = beacon(entry.state, time + i * 0.37, light);
      _bc.copy(BEACON_COLORS[b.color]);
      beaconMesh.setColorAt(i, b.on ? _bc.multiplyScalar(2.2) : BEACON_OFF);
      beaconMesh.setMatrixAt(i, _m.multiplyMatrices(base, PART.beacon));
      if (b.on) {
        _bc.copy(BEACON_COLORS[b.color]).multiplyScalar(b.glow);
        halo.setColorAt(i, _bc);
        halo.setMatrixAt(i, _m.multiplyMatrices(base, PART.halo));
      } else halo.setMatrixAt(i, ZERO);
      if (hit) {
        hit.position.set(pose.x, pose.y, pose.z);
        hit.rotation.set(0, pose.yaw, 0);
        hit.scale.setScalar(1);
      }
    }
    for (let k = 0; k < all.length; k++) all[k].instanceMatrix.needsUpdate = true;
    for (let k = 0; k < coloured.length; k++)
      if (coloured[k].instanceColor) coloured[k].instanceColor.needsUpdate = true;
  });

  return (
    <group>
      <primitive object={body} />
      <primitive object={canopy} />
      <primitive object={trim} />
      <primitive object={engine} />
      <primitive object={flame} />
      <primitive object={beaconMesh} />
      <primitive object={halo} />
      {entries.map((entry, i) => (
        <Clickable key={entry.pid} pid={entry.pid} onSelect={onSelect}>
          <mesh
            ref={(el) => {
              hitRefs.current[i] = el;
            }}
            scale={0}
          >
            <boxGeometry args={[2.4, 1, 2.9]} />
            <meshBasicMaterial visible={false} />
          </mesh>
        </Clickable>
      ))}
    </group>
  );
}

/** The newest queued event of a type for a pid, or undefined. */
function lastEvent(events, type, pid) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === type && e.pid === pid) return e;
  }
  return undefined;
}

// ── The environment ──────────────────────────────────────────

/** See ./index.js for the props every environment receives. */
export const Space = memo(function Space({ plan, look, office, events, onSelect }) {
  const invalidate = useThree((s) => s.invalidate);
  const { minX, maxX, minZ, maxZ } = plan;
  const frame = useMemo(
    () => stationFrame({ minX, maxX, minZ, maxZ }),
    [minX, maxX, minZ, maxZ]
  );
  const ports = useMemo(
    () => dockingPorts({ minX, maxX, minZ, maxZ }),
    [minX, maxX, minZ, maxZ]
  );
  const target = useMemo(() => [frame.cx, 0.4, frame.cz], [frame]);

  // Shuttles: each session (a departing one included) keeps its port.
  const slots = useRef(new Map());
  const sessions = liveSessions(office, { ended: true });
  const next = stickySlots(
    slots.current,
    sessions.map((s) => s.pid),
    ports.length
  );
  slots.current = next;
  const entryKey = sessions
    .map((s) => `${s.pid}:${s.state}:${s.projectKey}:${next.get(s.pid) ?? '-'}`)
    .join('|');
  const entries = useMemo(
    () =>
      sessions
        .filter((s) => next.has(s.pid))
        .map((s) => ({
          pid: s.pid,
          state: s.state,
          slot: next.get(s.pid),
          color: new THREE.Color(teamColor(s.projectKey ?? '')),
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entryKey]
  );
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  return (
    <group>
      <Atmosphere
        look={look}
        fogNear={NO_FOG_NEAR}
        fogFar={NO_FOG_FAR}
        invalidate={invalidate}
      />
      <Earth target={target} hour={look.hour} />
      <Hull frame={frame} ports={ports} />
      <Structure frame={frame} />
      <NavLights frame={frame} />
      <ShootingStars eventsRef={eventsRef} target={target} />
      <Shuttles
        ports={ports}
        entries={entries}
        entriesRef={entriesRef}
        eventsRef={eventsRef}
        onSelect={onSelect}
      />
    </group>
  );
});
