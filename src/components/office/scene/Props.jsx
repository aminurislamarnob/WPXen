import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { palette } from '../../../lib/office/scene/theme.js';
import { screenTexture } from '../../../lib/office/scene/textures.js';

// ── Screens ──────────────────────────────────────────────────

/** A screen surface. When `scroll` is set the content scrolls like live output. */
export function Screen({ kind, variant, width, height, scroll = false, tint }) {
  const tex = useMemo(() => {
    const t = screenTexture(kind, variant).clone();
    t.wrapT = THREE.RepeatWrapping;
    const tall = kind === 'code' || kind === 'terminal';
    // Show the top slice of tall textures so text keeps its proportions.
    if (tall) t.repeat.set(1, (height / width) * (512 / 640));
    t.needsUpdate = true;
    return t;
  }, [kind, variant, width, height]);
  const color = useMemo(() => new THREE.Color(tint ?? '#ffffff'), [tint]);

  useFrame((_, dt) => {
    if (scroll) tex.offset.y -= dt * 0.06;
  });

  return (
    <mesh>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={tex} color={color} toneMapped={false} />
    </mesh>
  );
}

/** Aluminium 27" display on a tilt stand (Studio Display–inspired, unbranded). */
export function Display({ kind, variant, scroll, tint, portrait = false, ...props }) {
  const w = portrait ? 0.34 : 0.62;
  const h = portrait ? 0.56 : 0.36;
  const lift = portrait ? 0.4 : 0.31;
  return (
    <group {...props}>
      {/* foot + stand */}
      <RoundedBox
        args={[0.2, 0.012, 0.16]}
        radius={0.005}
        position={[0, 0.006, 0]}
        castShadow
      >
        <meshStandardMaterial color={palette.aluminum} metalness={0.7} roughness={0.32} />
      </RoundedBox>
      <mesh position={[0, lift / 2, -0.05]} rotation={[-0.12, 0, 0]} castShadow>
        <boxGeometry args={[0.13, lift, 0.012]} />
        <meshStandardMaterial color={palette.aluminum} metalness={0.7} roughness={0.32} />
      </mesh>
      {/* body */}
      <group position={[0, lift + 0.02, -0.03]} rotation={[-0.06, 0, 0]}>
        <RoundedBox args={[w + 0.03, h + 0.03, 0.028]} radius={0.012} castShadow>
          <meshStandardMaterial
            color={palette.aluminum}
            metalness={0.65}
            roughness={0.3}
          />
        </RoundedBox>
        <mesh position={[0, 0, 0.0145]}>
          <planeGeometry args={[w + 0.016, h + 0.016]} />
          <meshStandardMaterial color={palette.screenBezel} roughness={0.2} />
        </mesh>
        <group position={[0, 0, 0.0152]}>
          <Screen
            kind={kind}
            variant={variant}
            width={w}
            height={h}
            scroll={scroll}
            tint={tint}
          />
        </group>
      </group>
    </group>
  );
}

/** Thin aluminium laptop, lid open at `angle` radians from closed. */
export function Laptop({
  kind,
  variant,
  angle = 1.85,
  scroll,
  finish = palette.aluminum,
  ...props
}) {
  return (
    <group {...props}>
      <RoundedBox
        args={[0.34, 0.012, 0.23]}
        radius={0.005}
        position={[0, 0.006, 0]}
        castShadow
      >
        <meshStandardMaterial color={finish} metalness={0.6} roughness={0.32} />
      </RoundedBox>
      {/* keyboard well + trackpad */}
      <mesh position={[0, 0.0125, -0.02]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.29, 0.1]} />
        <meshStandardMaterial color="#25272c" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.0125, 0.07]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.11, 0.065]} />
        <meshStandardMaterial color="#5a5e66" roughness={0.3} />
      </mesh>
      <group position={[0, 0.012, -0.112]} rotation={[-(angle - Math.PI / 2), 0, 0]}>
        <RoundedBox
          args={[0.34, 0.22, 0.008]}
          radius={0.004}
          position={[0, 0.11, 0]}
          castShadow
        >
          <meshStandardMaterial color={finish} metalness={0.6} roughness={0.32} />
        </RoundedBox>
        <group position={[0, 0.112, 0.0045]}>
          <Screen
            kind={kind}
            variant={variant}
            width={0.31}
            height={0.19}
            scroll={scroll}
          />
        </group>
      </group>
    </group>
  );
}

// ── Desk peripherals ─────────────────────────────────────────

const KEY_ROWS = 5;
const KEY_COLS = 14;

/** 65% mechanical keyboard with keycaps; accent keys in the brand colour. */
export function MechanicalKeyboard({ accent = palette.keycapAccent, ...props }) {
  const ref = useRef(null);
  const keys = useMemo(() => {
    const list = [];
    for (let r = 0; r < KEY_ROWS; r++)
      for (let c = 0; c < KEY_COLS; c++) {
        if (r === 4 && c > 3 && c < 10 && c !== 4) continue; // space bar slot
        list.push({
          pos: [-0.169 + c * 0.026, 0.024, -0.052 + r * 0.026],
          accent: (r === 0 && c === 0) || (r === 2 && c === 13) || (r === 4 && c === 13),
        });
      }
    return list;
  }, []);

  const setRef = (mesh) => {
    ref.current = mesh;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const base = new THREE.Color(palette.keycap);
    const acc = new THREE.Color(accent);
    keys.forEach((k, i) => {
      m.makeTranslation(...k.pos);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, k.accent ? acc : base);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  return (
    <group {...props}>
      <RoundedBox
        args={[0.385, 0.022, 0.14]}
        radius={0.008}
        position={[0, 0.011, 0]}
        castShadow
      >
        <meshStandardMaterial
          color={palette.keyboardBase}
          metalness={0.4}
          roughness={0.45}
        />
      </RoundedBox>
      <instancedMesh ref={setRef} args={[undefined, undefined, keys.length]} castShadow>
        <boxGeometry args={[0.022, 0.012, 0.022]} />
        <meshStandardMaterial roughness={0.55} />
      </instancedMesh>
      <RoundedBox
        args={[0.13, 0.012, 0.022]}
        radius={0.004}
        position={[0.005, 0.024, 0.052]}
      >
        <meshStandardMaterial color={palette.keycap} roughness={0.55} />
      </RoundedBox>
    </group>
  );
}

export function Mouse(props) {
  return (
    <group {...props}>
      <mesh scale={[0.034, 0.014, 0.058]} position={[0, 0.01, 0]} castShadow>
        <sphereGeometry args={[1, 24, 16]} />
        <meshStandardMaterial color="#f5f5f4" roughness={0.25} />
      </mesh>
    </group>
  );
}

/** Ceramic mug; `steam` adds rising wisps while the coffee is hot. */
export function Mug({ color = '#f4f2ee', steam = false, ...props }) {
  const wisps = useRef(null);
  useFrame(({ clock }) => {
    if (!steam || !wisps.current) return;
    wisps.current.children.forEach((c, i) => {
      const t = (clock.elapsedTime * 0.5 + i / 3) % 1;
      c.position.y = 0.1 + t * 0.12;
      c.position.x = Math.sin(t * 6 + i) * 0.01;
      c.scale.setScalar(0.012 + t * 0.016);
      c.material.opacity = 0.35 * (1 - t);
    });
  });
  return (
    <group {...props}>
      <mesh position={[0, 0.045, 0]} castShadow>
        <cylinderGeometry args={[0.035, 0.032, 0.09, 24]} />
        <meshStandardMaterial color={color} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.086, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.031, 24]} />
        <meshStandardMaterial color="#4a2c1d" roughness={0.2} />
      </mesh>
      <mesh position={[0.038, 0.045, 0]} rotation={[0, 0, Math.PI / 2]}>
        <torusGeometry args={[0.02, 0.006, 8, 16, Math.PI]} />
        <meshStandardMaterial color={color} roughness={0.35} />
      </mesh>
      {steam && (
        <group ref={wisps} userData={{ live: true }}>
          {[0, 1, 2].map((i) => (
            <mesh key={i}>
              <sphereGeometry args={[1, 10, 8]} />
              <meshBasicMaterial
                color="#ffffff"
                transparent
                opacity={0.3}
                depthWrite={false}
              />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}

/** Over-ear headphones resting on the desk. */
export function Headphones({ color = '#2b2d33', ...props }) {
  return (
    <group {...props}>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <torusGeometry args={[0.075, 0.009, 10, 32, Math.PI]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
      {[-1, 1].map((s) => (
        <RoundedBox
          key={s}
          args={[0.05, 0.06, 0.04]}
          radius={0.018}
          position={[s * 0.075, 0.03, 0]}
          castShadow
        >
          <meshStandardMaterial color={color} roughness={0.6} />
        </RoundedBox>
      ))}
    </group>
  );
}

/** Small desk succulent in a ceramic pot. */
export function DeskPlant({ pot = palette.pot, ...props }) {
  return (
    <group {...props}>
      <mesh position={[0, 0.035, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.032, 0.07, 20]} />
        <meshStandardMaterial color={pot} roughness={0.6} />
      </mesh>
      {Array.from({ length: 7 }).map((_, i) => {
        const a = (i / 7) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * 0.018, 0.09, Math.sin(a) * 0.018]}
            rotation={[Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6]}
            scale={[0.014, 0.04, 0.014]}
            castShadow
          >
            <sphereGeometry args={[1, 10, 8]} />
            <meshStandardMaterial
              color={i % 2 ? palette.plantLeaf : palette.plantLeafLight}
              roughness={0.7}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/** Tall floor plant with broad leaves (monstera-like). */
export function FloorPlant({ size = 1, pot = palette.pot, ...props }) {
  const leaves = useMemo(
    () =>
      Array.from({ length: 11 }).map((_, i) => {
        const a = i * 2.39996;
        const h = 0.45 + (i / 11) * 0.65;
        return { a, h, tilt: 0.5 + (i % 3) * 0.25 };
      }),
    []
  );
  return (
    <group {...props} scale={size}>
      <mesh position={[0, 0.17, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.17, 0.13, 0.34, 28]} />
        <meshStandardMaterial color={pot} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.335, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.16, 24]} />
        <meshStandardMaterial color="#5b4636" roughness={1} />
      </mesh>
      {leaves.map(({ a, h, tilt }, i) => (
        <group key={i} position={[0, 0.33, 0]} rotation={[0, a, 0]}>
          <mesh position={[0, h / 2, 0.05]} rotation={[tilt * 0.3, 0, 0]}>
            <cylinderGeometry args={[0.006, 0.008, h, 6]} />
            <meshStandardMaterial color="#3f6e48" roughness={0.8} />
          </mesh>
          <mesh
            position={[0, h, 0.12 + tilt * 0.08]}
            rotation={[tilt, 0, 0]}
            scale={[0.15, 0.012, 0.2]}
            castShadow
          >
            <sphereGeometry args={[1, 16, 10]} />
            <meshStandardMaterial
              color={i % 3 ? palette.plantLeaf : palette.plantLeafLight}
              roughness={0.65}
              side={THREE.DoubleSide}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Minimal arched desk lamp. */
export function DeskLamp({ on = true, ...props }) {
  return (
    <group {...props}>
      <mesh position={[0, 0.006, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.06, 0.012, 24]} />
        <meshStandardMaterial color={palette.ink} roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.006, 0.006, 0.4, 8]} />
        <meshStandardMaterial color={palette.ink} roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[0.07, 0.4, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.006, 0.006, 0.14, 8]} />
        <meshStandardMaterial color={palette.ink} roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[0.15, 0.385, 0]} castShadow>
        <coneGeometry args={[0.05, 0.06, 24, 1, true]} />
        <meshStandardMaterial
          color={palette.ink}
          roughness={0.4}
          metalness={0.3}
          side={THREE.DoubleSide}
        />
      </mesh>
      {on && (
        <mesh position={[0.15, 0.36, 0]}>
          <sphereGeometry args={[0.018, 12, 8]} />
          <meshBasicMaterial color="#fff3d6" toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

/** Ergonomic mesh office chair. Faces +z. */
export function OfficeChair({ color = palette.chair, ...props }) {
  return (
    <group {...props}>
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2;
        return (
          <group key={i} rotation={[0, a, 0]}>
            <mesh position={[0, 0.05, 0.13]} rotation={[0.12, 0, 0]} castShadow>
              <boxGeometry args={[0.03, 0.022, 0.26]} />
              <meshStandardMaterial color={palette.ink} roughness={0.5} />
            </mesh>
            <mesh position={[0, 0.025, 0.26]}>
              <sphereGeometry args={[0.024, 10, 8]} />
              <meshStandardMaterial color="#111" roughness={0.6} />
            </mesh>
          </group>
        );
      })}
      <mesh position={[0, 0.25, 0]} castShadow>
        <cylinderGeometry args={[0.022, 0.026, 0.36, 12]} />
        <meshStandardMaterial
          color={palette.aluminumDark}
          metalness={0.8}
          roughness={0.3}
        />
      </mesh>
      <RoundedBox
        args={[0.46, 0.07, 0.44]}
        radius={0.03}
        position={[0, 0.45, 0]}
        castShadow
      >
        <meshStandardMaterial color={color} roughness={0.8} />
      </RoundedBox>
      <mesh position={[0, 0.62, -0.24]} rotation={[-0.15, 0, 0]} castShadow>
        <boxGeometry args={[0.03, 0.34, 0.03]} />
        <meshStandardMaterial color={palette.ink} roughness={0.5} />
      </mesh>
      <RoundedBox
        args={[0.44, 0.5, 0.05]}
        radius={0.04}
        position={[0, 0.82, -0.27]}
        rotation={[-0.15, 0, 0]}
        castShadow
      >
        <meshStandardMaterial color={palette.chairMesh} roughness={0.9} />
      </RoundedBox>
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 0.24, 0.6, -0.02]}>
          <mesh position={[0, -0.06, 0]}>
            <boxGeometry args={[0.025, 0.12, 0.025]} />
            <meshStandardMaterial color={palette.ink} roughness={0.5} />
          </mesh>
          <RoundedBox args={[0.05, 0.025, 0.2]} radius={0.01}>
            <meshStandardMaterial color={palette.ink} roughness={0.6} />
          </RoundedBox>
        </group>
      ))}
    </group>
  );
}

/** Stack of notebooks and a pen. */
export function Notebooks(props) {
  return (
    <group {...props}>
      {['#d97757', '#2f3440', '#e8e4dc'].map((c, i) => (
        <RoundedBox
          key={i}
          args={[0.15, 0.016, 0.21]}
          radius={0.004}
          position={[i * 0.006, 0.008 + i * 0.017, i * 0.004]}
          rotation={[0, i * 0.12, 0]}
          castShadow
        >
          <meshStandardMaterial color={c} roughness={0.8} />
        </RoundedBox>
      ))}
      <mesh position={[0.02, 0.06, 0]} rotation={[0, 0.7, Math.PI / 2]}>
        <cylinderGeometry args={[0.004, 0.004, 0.14, 8]} />
        <meshStandardMaterial color={palette.ink} />
      </mesh>
    </group>
  );
}
