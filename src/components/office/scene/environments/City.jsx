import { memo, useEffect, useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { STREET_Y, TINTS, planCity } from '../../../../lib/office/scene/city.js';
import {
  Atmosphere,
  BLOB,
  BOX,
  boxMatrix,
  dayFactor,
  exteriorMaterial,
  makeExteriorUniforms,
  useInstances,
} from './common.jsx';

// ── City high-rise ───────────────────────────────────────────
// The room as the top floor of a glass tower: the tower below its floor, the
// city around it down to the street, the sky and the haze — all lit by the
// local-time look (lib/office/scene/daylight.js). The layout is planned by the
// pure lib/office/scene/city.js, which also guarantees nothing rises between
// the camera and the room.
//
// Every building is one instance of a single box (one draw call) with its
// windows drawn in the shader; streets, trees and rooftop plant are one
// instanced mesh each. The city changes only when the room's bounds do; the
// time of day only moves shared uniforms.

/** Ground disc radius: past the city's edge, so its rim is always in the haze. */
const GROUND_RADIUS = 420;

const seedFor = (kind) => (kind === 'antigravity' ? 11 : 3);

const _c = new THREE.Color();

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
    BLOB,
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

/** See ./index.js for the props every environment receives. */
export const City = memo(function City({ plan, kind, look }) {
  const invalidate = useThree((s) => s.invalidate);
  const { minX, maxX, minZ, maxZ } = plan;
  const city = useMemo(
    () => planCity({ minX, maxX, minZ, maxZ }, { seed: seedFor(kind) }),
    [minX, maxX, minZ, maxZ, kind]
  );
  const uniforms = useMemo(
    () => makeExteriorUniforms({ haze: 0.45, hazeDepth: -STREET_Y, streetY: STREET_Y }),
    []
  );
  return (
    <group>
      <Atmosphere look={look} invalidate={invalidate} />
      <Buildings city={city} look={look} uniforms={uniforms} invalidate={invalidate} />
      <Streets city={city} look={look} uniforms={uniforms} invalidate={invalidate} />
    </group>
  );
}, cityEqual);

/** The city only follows the room's bounds, its kind and the moment. */
function cityEqual(a, b) {
  return (
    a.kind === b.kind &&
    a.look === b.look &&
    a.plan.minX === b.plan.minX &&
    a.plan.maxX === b.plan.maxX &&
    a.plan.minZ === b.plan.minZ &&
    a.plan.maxZ === b.plan.maxZ
  );
}
