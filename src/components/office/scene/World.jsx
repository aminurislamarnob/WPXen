import { memo, useEffect, useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { FLOOR_H, STREET_Y, TINTS, planCity } from '../../../lib/office/scene/city.js';
import { skyTexture } from '../../../lib/office/scene/textures.js';

// ── World ────────────────────────────────────────────────────
// What the Office stands in: the tower below its floor, the city around it
// down to the street, the sky and the haze — all lit by the same local-time
// look as the room (lib/office/scene/daylight.js). The layout is planned by
// the pure lib/office/scene/city.js, which also guarantees nothing rises
// between the camera and the room.
//
// Built for the perf budget the scene keeps elsewhere: every building is one
// instance of a single box (one draw call), their windows are drawn in the
// shader rather than modelled or textured, and nothing out here casts or
// receives shadows — the shadow map stays the room's. The city changes only
// when the room's bounds do; the time of day only moves a few uniforms.

/** How far the camera sits from what it looks at (OfficeScene's camera). */
export const CAMERA_DISTANCE = 220;
/** Haze starts just past the room's far corner... */
const FOG_NEAR = CAMERA_DISTANCE + 14;
/** ...and has swallowed the skyline a few blocks out. */
const FOG_FAR = CAMERA_DISTANCE + 190;
/** How much of the fog colour the street, 17 storeys down, takes on. */
const HEIGHT_HAZE = 0.45;
/** Window bay width on every facade, in scene units. */
const BAY = 1.7;
/** Ground disc radius: past the city's edge, so its rim is always in the haze. */
const GROUND_RADIUS = 420;

const seedFor = (kind) => (kind === 'antigravity' ? 11 : 3);

/**
 * Darkens the city's own surfaces at night while the office lights (a warm
 * hemisphere light) stay on inside: the factor every exterior colour is
 * multiplied by.
 */
const dayFactor = (look) => 0.14 + 0.86 * look.day;

// ── Exterior shader ──────────────────────────────────────────
// Every outdoor material is a MeshStandardMaterial with a few lines injected:
// all of them get height haze (the deeper below the office, the more the air
// between swallows it, on top of the distance fog), and buildings also get
// their window grid. The uniforms are shared, so one update re-lights the
// whole city.

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
uniform float uStreetY;
varying vec3 vCityPos;
#ifdef CITY_WINDOWS
  uniform float uNight;
  uniform float uDay;
  uniform vec3 uGlass;
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
    // A fifth to a third of the offices are still lit at night, each its own brightness.
    float lit = step( 0.66 + vCitySeed * 0.14, cityHash( id + vCitySeed * 37.0 ) );
    cityGlow = pane * lit * uNight * ( 0.45 + 0.55 * cityHash( id * 0.73 + 9.2 ) );
    cityGlowColor = mix( vec3( 1.0, 0.74, 0.42 ), vec3( 0.82, 0.9, 1.0 ), step( 0.78, cityHash( id * 1.7 + 3.1 ) ) );
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
  float cityDrop = clamp( -vCityPos.y / ${(-STREET_Y).toFixed(1)}, 0.0, 1.0 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, cityDrop * uHaze );
#endif
`;

/**
 * @param {Record<string, { value: unknown }>} uniforms Shared across the city.
 * @param {{ windows?: boolean } & THREE.MeshStandardMaterialParameters} [opts]
 */
function exteriorMaterial(uniforms, { windows = false, ...params } = {}) {
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

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function boxMatrix(x, y, z, w, h, d) {
  return _m.compose(_p.set(x, y, z), _q, _s.set(w, h, d));
}

function Buildings({ city, look, uniforms, invalidate }) {
  const material = useMemo(
    () => exteriorMaterial(uniforms, { windows: true, roughness: 0.62, metalness: 0.08 }),
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
      _c.set(TINTS[b.tint]);
      tints.set([_c.r, _c.g, _c.b], i * 3);
      seeds[i] = b.seed;
    });
    geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    m.frustumCulled = false;
    return m;
  }, [city, material]);

  // A re-planned city (the room grew) frees the old one's GPU buffers.
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.dispose();
    },
    [mesh]
  );
  useEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    uniforms.uNight.value = look.windows;
    uniforms.uDay.value = look.day;
    uniforms.uStreetY.value = city.streetY;
    // Glass picks up the sky: blue by day, the horizon's glow at golden hour.
    uniforms.uGlass.value.set(look.skyHorizon).lerp(_c.set(look.skyTop), 0.35);
    invalidate();
  }, [look, city, uniforms, invalidate]);

  return <primitive object={mesh} />;
}

// ── Streets, parks and rooftop plant ─────────────────────────

/** An instanced mesh of boxes or blobs, one colour each, never shadowed. */
function useInstances(uniforms, geometry, items, place, color) {
  const material = useMemo(
    () => exteriorMaterial(uniforms, { roughness: 0.95 }),
    [uniforms]
  );
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, Math.max(items.length, 1));
    m.count = items.length;
    items.forEach((item, i) => {
      m.setMatrixAt(i, place(item));
      m.setColorAt(i, _c.set(color(item, i)));
    });
    m.frustumCulled = false;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, items, material]);
  // The geometry is shared module-wide; only the instance buffers are this mesh's.
  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => () => material.dispose(), [material]);
  return { mesh, material };
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CROWN = new THREE.IcosahedronGeometry(1, 1);

function Streets({ city, look, uniforms, invalidate }) {
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
    (b) => (b.park ? '#6f9659' : '#b8b2a7')
  );
  const trees = useInstances(
    uniforms,
    CROWN,
    city.trees,
    (t) => boxMatrix(t.x, y + 0.24 + t.r * 1.05, t.z, t.r, t.r * 1.15, t.r),
    (_, i) => (i % 3 ? '#4f7f45' : '#5f9150')
  );
  const roofs = useInstances(
    uniforms,
    BOX,
    city.roofUnits,
    (u) => boxMatrix(u.x, u.base + u.h / 2, u.z, u.w, u.h, u.d),
    (_, i) => (i % 4 ? '#9a9ea4' : '#7c8189')
  );
  const ground = useMemo(
    () => exteriorMaterial(uniforms, { color: '#5b5e63', roughness: 1 }),
    [uniforms]
  );
  useEffect(() => () => ground.dispose(), [ground]);

  useLayoutEffect(() => {
    const k = dayFactor(look);
    for (const m of [blocks.material, trees.material, roofs.material])
      m.color.setScalar(k);
    ground.color.set('#5b5e63').multiplyScalar(k);
    invalidate();
  }, [look, blocks.material, trees.material, roofs.material, ground, invalidate]);

  const cx = (city.room.x0 + city.room.x1) / 2;
  const cz = (city.room.z0 + city.room.z1) / 2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, y, cz]} material={ground}>
        <circleGeometry args={[GROUND_RADIUS, 64]} />
      </mesh>
      <primitive object={blocks.mesh} />
      <primitive object={trees.mesh} />
      <primitive object={roofs.mesh} />
    </group>
  );
}

// ── Sky and haze ─────────────────────────────────────────────

function Atmosphere({ look, invalidate }) {
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    scene.fog = new THREE.Fog('#ffffff', FOG_NEAR, FOG_FAR);
    return () => {
      scene.fog = null;
    };
  }, [scene]);

  useEffect(() => {
    scene.fog?.color.set(look.fog);
    const sky = skyTexture(look);
    scene.background = sky;
    invalidate();
    return () => {
      if (scene.background === sky) scene.background = null;
      sky.dispose();
    };
  }, [scene, look, invalidate]);

  return null;
}

/** Same bounds, same room kind, same moment: nothing out here changes. */
const worldEqual = (a, b) =>
  a.kind === b.kind &&
  a.look === b.look &&
  a.plan.minX === b.plan.minX &&
  a.plan.maxX === b.plan.maxX &&
  a.plan.minZ === b.plan.minZ &&
  a.plan.maxZ === b.plan.maxZ;

/**
 * @param {object} props
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} props.plan
 * @param {string} props.kind The room kind; each room's tower stands in its own city.
 * @param {ReturnType<import('../../../lib/office/scene/daylight.js').daylightAt>} props.look
 */
export const World = memo(function World({ plan, kind, look }) {
  const invalidate = useThree((s) => s.invalidate);
  const { minX, maxX, minZ, maxZ } = plan;
  const city = useMemo(
    () => planCity({ minX, maxX, minZ, maxZ }, { seed: seedFor(kind) }),
    [minX, maxX, minZ, maxZ, kind]
  );
  const uniforms = useMemo(
    () => ({
      uHaze: { value: HEIGHT_HAZE },
      uNight: { value: 0 },
      uDay: { value: 1 },
      uStreetY: { value: city.streetY },
      uGlass: { value: new THREE.Color() },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  return (
    <group>
      <Atmosphere look={look} invalidate={invalidate} />
      <Buildings city={city} look={look} uniforms={uniforms} invalidate={invalidate} />
      <Streets city={city} look={look} uniforms={uniforms} invalidate={invalidate} />
    </group>
  );
}, worldEqual);
