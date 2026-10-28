import { useMemo } from 'react';
import * as THREE from 'three';
import { RoundedBox } from '@react-three/drei';
import { DeskPlant, FloorPlant } from './Props.jsx';
import { palette } from '../../../lib/office/scene/theme.js';
import {
  nameplateTexture,
  screenTexture,
  skylineTexture,
  woodTexture,
} from '../../../lib/office/scene/textures.js';
import { StaticBatch } from './StaticBatch.jsx';

// ── Room shell ───────────────────────────────────────────────
// Floor, walls, nameplate and the culture pieces that belong to this ticket.
// The social corner — sofa, bean bags, coffee bar, play zone, arcade, neon
// sign, posters, whiteboard, server rack, bookshelf — arrives with the lounge
// and breaks ticket (#184), filling the amenity zones the floor plan already
// reserves. Geometry here is ported pixel-faithful from the source Room.tsx.

const WALL_H = 3.1;
const WALL_T = 0.14;
const SLAB = 0.35;

function Floor({ plan }) {
  const w = plan.maxX - plan.minX + 1;
  const d = plan.maxZ - plan.minZ + 1;
  const tex = useMemo(() => {
    const t = woodTexture();
    t.repeat.set(w / 3, d / 3);
    return t;
  }, [w, d]);
  const cx = (plan.minX + plan.maxX + 1) / 2;
  const cz = (plan.minZ + plan.maxZ + 1) / 2;
  return (
    <group position={[cx, 0, cz]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial map={tex} roughness={0.72} />
      </mesh>
      {/* diorama slab */}
      <RoundedBox
        args={[w + 0.02, SLAB, d + 0.02]}
        radius={0.05}
        position={[0, -SLAB / 2 - 0.004, 0]}
        receiveShadow
      >
        <meshStandardMaterial color="#e7e1d6" roughness={0.9} />
      </RoundedBox>
      <mesh position={[0, -SLAB - 0.03, 0]}>
        <boxGeometry args={[w - 0.2, 0.06, d - 0.2]} />
        <meshStandardMaterial color="#c9c1b3" roughness={1} />
      </mesh>
    </group>
  );
}

function Walls({ plan, color }) {
  const w = plan.maxX - plan.minX + 1;
  const d = plan.maxZ - plan.minZ + 1;
  const sky = useMemo(() => skylineTexture(), []);
  const winCount = Math.max(2, Math.floor((d - 1.2) / 2.2));
  const winSpan = (d - 1.2) / winCount;
  return (
    <group>
      {/* back wall */}
      <mesh
        position={[(plan.minX + plan.maxX + 1) / 2, WALL_H / 2, plan.minZ - WALL_T / 2]}
        receiveShadow
        castShadow
      >
        <boxGeometry args={[w + WALL_T * 2, WALL_H, WALL_T]} />
        <meshStandardMaterial color={color} roughness={0.92} />
      </mesh>
      <mesh position={[(plan.minX + plan.maxX + 1) / 2, 0.06, plan.minZ + 0.01]}>
        <boxGeometry args={[w, 0.12, 0.02]} />
        <meshStandardMaterial color={palette.wallTrim} roughness={0.8} />
      </mesh>
      {/* left wall: floor-to-ceiling glazing with the skyline behind */}
      <group position={[plan.minX - WALL_T / 2, 0, plan.minZ]}>
        <mesh position={[0, WALL_H / 2, d / 2]} castShadow receiveShadow>
          <boxGeometry args={[WALL_T, WALL_H, d]} />
          <meshStandardMaterial color={color} roughness={0.92} />
        </mesh>
        {Array.from({ length: winCount }).map((_, i) => {
          const z = 0.6 + winSpan * (i + 0.5);
          const ww = winSpan - 0.24;
          return (
            <group
              key={i}
              position={[WALL_T / 2 + 0.002, 1.6, z]}
              rotation={[0, Math.PI / 2, 0]}
            >
              <mesh>
                <planeGeometry args={[ww, 2.3]} />
                <meshBasicMaterial map={sky} toneMapped={false} />
              </mesh>
              {/* mullions */}
              {[-ww / 2, 0, ww / 2].map((x, k) => (
                <mesh key={k} position={[x, 0, 0.02]}>
                  <boxGeometry args={[0.05, 2.36, 0.04]} />
                  <meshStandardMaterial
                    color={palette.ink}
                    roughness={0.4}
                    metalness={0.4}
                  />
                </mesh>
              ))}
              {[-1.15, 1.15].map((y, k) => (
                <mesh key={k} position={[0, y, 0.02]}>
                  <boxGeometry args={[ww + 0.05, 0.05, 0.04]} />
                  <meshStandardMaterial
                    color={palette.ink}
                    roughness={0.4}
                    metalness={0.4}
                  />
                </mesh>
              ))}
            </group>
          );
        })}
      </group>
    </group>
  );
}

let beanBagGeo = null;

/**
 * A slumped bean bag: wide at the floor, a raised back, a hollow to sink into
 * and soft creases. Built once by reshaping a sphere. Local +z is the sitter's
 * front.
 */
function beanBagGeometry() {
  if (beanBagGeo) return beanBagGeo;
  const g = new THREE.SphereGeometry(1, 64, 40);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const { x, y, z } = v;
    const back = THREE.MathUtils.smoothstep(-z, -0.2, 0.9); // 0 at the front, 1 at the back
    const side = THREE.MathUtils.smoothstep(Math.abs(x), 0.35, 0.95); // sides hug the sitter
    let h = y > 0 ? y * (0.5 + 0.6 * back + 0.3 * side * (1 - back * 0.5)) : y * 0.5;
    h -= 0.3 * Math.exp(-((x / 0.5) ** 2) - ((z - 0.2) / 0.5) ** 2) * Math.max(0, y); // seat hollow
    h = Math.max(h, -0.42); // flat where it rests on the floor
    const slump = 1 + 0.2 * (1 - y) * 0.5; // spreads out toward the floor
    const crease =
      0.03 * Math.sin(7 * Math.atan2(z, x) + y * 4) * (1 - Math.abs(y)) * (0.4 + back);
    const r = 0.5 * (slump + crease);
    pos.setXYZ(i, x * r, (h + 0.42) * 0.42, z * r);
  }
  g.computeVertexNormals();
  return (beanBagGeo = g);
}

export function BeanBag({ color = '#d9a066', ...props }) {
  const sheen = useMemo(
    () => new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.35),
    [color]
  );
  return (
    <group {...props}>
      <mesh geometry={beanBagGeometry()} castShadow receiveShadow>
        <meshPhysicalMaterial
          color={color}
          roughness={0.92}
          sheen={1}
          sheenColor={sheen}
          sheenRoughness={0.45}
        />
      </mesh>
    </group>
  );
}

/** Wall-mounted team dashboard. */
function WallScreen(props) {
  const tex = useMemo(() => screenTexture('dashboard', 'wall'), []);
  return (
    <group {...props}>
      <RoundedBox args={[1.9, 1.08, 0.05]} radius={0.015} castShadow>
        <meshStandardMaterial color={palette.screenBezel} roughness={0.3} />
      </RoundedBox>
      <mesh position={[0, 0, 0.027]}>
        <planeGeometry args={[1.84, 1.02]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Credenza({ accent = palette.accent, ...props }) {
  return (
    <group {...props}>
      <RoundedBox
        args={[1.9, 0.56, 0.46]}
        radius={0.02}
        position={[0, 0.3, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#ebe5da" roughness={0.6} />
      </RoundedBox>
      {[-0.63, 0, 0.63].map((x) => (
        <mesh key={x} position={[x, 0.3, 0.232]}>
          <boxGeometry args={[0.6, 0.5, 0.005]} />
          <meshStandardMaterial color="#e2dbcf" roughness={0.7} />
        </mesh>
      ))}
      {[-0.8, 0.8].map((x) => (
        <mesh key={x} position={[x, 0.01, 0]}>
          <boxGeometry args={[0.04, 0.04, 0.4]} />
          <meshStandardMaterial color={palette.ink} />
        </mesh>
      ))}
      <DeskPlant position={[-0.7, 0.58, 0]} pot={palette.potDark} />
      {/* books */}
      {['#d97757', '#2f3440', '#5b6cff', '#e8e4dc'].map((c, i) => (
        <mesh
          key={c}
          position={[0.3 + i * 0.05, 0.71, 0]}
          rotation={[0, 0, i === 3 ? -0.25 : 0]}
          castShadow
        >
          <boxGeometry args={[0.04, 0.24 - (i % 2) * 0.03, 0.18]} />
          <meshStandardMaterial color={c} roughness={0.8} />
        </mesh>
      ))}
      {/* tiny robot figure */}
      <group position={[0.75, 0.58, 0]}>
        <RoundedBox args={[0.1, 0.1, 0.08]} radius={0.02} position={[0, 0.06, 0]}>
          <meshStandardMaterial color={accent} roughness={0.5} />
        </RoundedBox>
        <RoundedBox args={[0.13, 0.1, 0.1]} radius={0.03} position={[0, 0.16, 0]}>
          <meshStandardMaterial color="#f4f2ee" roughness={0.4} />
        </RoundedBox>
        {[-1, 1].map((s) => (
          <mesh key={s} position={[s * 0.03, 0.165, 0.051]}>
            <circleGeometry args={[0.012, 12]} />
            <meshBasicMaterial color="#1d1f24" />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** The room's name, high on the back wall where it reads from any angle. */
function Nameplate({ theme, ...props }) {
  const tex = useMemo(
    () => nameplateTexture(theme.name, theme.accent),
    [theme.name, theme.accent]
  );
  return (
    <group {...props}>
      <RoundedBox args={[2.4, 0.375, 0.03]} radius={0.012} castShadow>
        <meshStandardMaterial color={palette.ink} roughness={0.4} />
      </RoundedBox>
      <mesh position={[0, 0, 0.016]}>
        <planeGeometry args={[2.38, 0.36]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </group>
  );
}

// ── Room assembly ────────────────────────────────────────────

/**
 * The office shell plus the culture pieces along the back and left walls that
 * land with this ticket. Back-wall amenity zones are laid out left to right by
 * the floor plan; the lounge, coffee, play, neon and arcade zones stay empty
 * until #184 ports their furniture.
 */
export function Room({ plan, theme }) {
  const bz = plan.minZ; // back wall interior face
  const lx = plan.minX; // left wall interior face
  const right = plan.maxX + 1;

  const zones = plan.amenities.zones.map(({ kind, x }) => {
    switch (kind) {
      case 'lounge':
        // #184 adds Whiteboard, Rug, Sofa, CoffeeTable and BeanBags here; the
        // nameplate belongs to the room itself.
        return (
          <group key={kind} position={[x, 0, bz]}>
            <Nameplate theme={theme} position={[0, 2.72, 0.03]} />
          </group>
        );
      case 'screen':
        return (
          <group key={kind} position={[x, 0, bz]}>
            <WallScreen position={[0, 1.65, 0.04]} />
            <Credenza position={[0, 0, 0.3]} accent={theme.accent} />
          </group>
        );
      case 'coffee': // CoffeeBar + HighTable (#184)
      case 'play': // PlayZone (#184)
      case 'neon': // NeonSign + Posters (#184)
      case 'arcade': // Arcade + Poster (#184)
      default:
        return null;
    }
  });

  const sideLen = plan.maxZ + 1 - bz;
  const layout = `${theme.kind},${lx},${right},${bz},${plan.maxZ},${plan.amenities.zones.map((z) => z.kind).join()}`;

  return (
    <StaticBatch version={layout}>
      <Floor plan={plan} />
      <Walls plan={plan} color={theme.wall} />
      {zones}
      {/* corner + left-wall pieces (ServerRack and Bookshelf join them in #184) */}
      <FloorPlant position={[lx + 0.5, 0, bz + 0.5]} size={1.25} />
      <FloorPlant
        position={[right - 0.45, 0, bz + 0.45]}
        size={1.05}
        pot={palette.potDark}
      />
      <group position={[lx + 0.35, 0, 0]}>
        {sideLen > 8 && <FloorPlant position={[0.25, 0, bz + 4.4]} size={0.95} />}
        {sideLen > 10 && (
          <BeanBag
            position={[0.75, 0, bz + 5.6]}
            rotation={[0, 1.2, 0]}
            color="#8a93a6"
          />
        )}
        {sideLen > 13 && (
          <FloorPlant
            position={[0.25, 0, plan.maxZ + 0.3]}
            size={1.1}
            pot={palette.potDark}
          />
        )}
      </group>
    </StaticBatch>
  );
}
