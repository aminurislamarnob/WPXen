import { useContext, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { BreakPresence, RALLY_PERIOD } from '../../../lib/office/scene/breaks.js';
import { PINGPONG_HALF } from '../../../lib/office/scene/layout.js';
import { palette } from '../../../lib/office/scene/theme.js';
import { scoreboardTexture } from '../../../lib/office/scene/textures.js';

// ── Play zone ────────────────────────────────────────────────
// A ping-pong table on a court mat. Positions are relative to the zone origin
// on the back wall; the table sits at `tableZ` in front of it.

const TOP = 0.68;
const LEN = 2.0;
const WID = 1.1;
const BAT_X = 1.02; // where the ball meets a bat, from the table centre
const BAT_Y = 0.98;

function Table() {
  const lines = '#f4f2ee';
  return (
    <group>
      <RoundedBox
        args={[LEN, 0.04, WID]}
        radius={0.01}
        position={[0, TOP - 0.02, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#2f5fa8" roughness={0.45} />
      </RoundedBox>
      {/* white edge and centre lines */}
      {[-1, 1].map((s) => (
        <mesh key={`e${s}`} position={[0, TOP + 0.001, s * (WID / 2 - 0.012)]}>
          <boxGeometry args={[LEN, 0.002, 0.018]} />
          <meshBasicMaterial color={lines} />
        </mesh>
      ))}
      {[-1, 1].map((s) => (
        <mesh key={`x${s}`} position={[s * (LEN / 2 - 0.012), TOP + 0.001, 0]}>
          <boxGeometry args={[0.018, 0.002, WID]} />
          <meshBasicMaterial color={lines} />
        </mesh>
      ))}
      <mesh position={[0, TOP + 0.001, 0]}>
        <boxGeometry args={[LEN, 0.002, 0.008]} />
        <meshBasicMaterial color={lines} />
      </mesh>
      {/* net */}
      <mesh position={[0, TOP + 0.06, 0]}>
        <boxGeometry args={[0.006, 0.11, WID + 0.08]} />
        <meshStandardMaterial
          color="#e9e6e0"
          transparent
          opacity={0.55}
          roughness={0.9}
        />
      </mesh>
      <mesh position={[0, TOP + 0.115, 0]}>
        <boxGeometry args={[0.012, 0.012, WID + 0.08]} />
        <meshStandardMaterial color="#f4f2ee" roughness={0.5} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={`p${s}`} position={[0, TOP + 0.05, s * (WID / 2 + 0.04)]}>
          <cylinderGeometry args={[0.012, 0.012, 0.13, 8]} />
          <meshStandardMaterial color={palette.deskLeg} metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
      {/* steel A-frame legs */}
      {[-1, 1].map((s) => (
        <group key={`l${s}`} position={[s * 0.62, 0, 0]}>
          {[-1, 1].map((z) => (
            <mesh
              key={z}
              position={[0, (TOP - 0.04) / 2, z * 0.38]}
              rotation={[z * 0.12, 0, 0]}
              castShadow
            >
              <boxGeometry args={[0.04, TOP - 0.04, 0.04]} />
              <meshStandardMaterial
                color={palette.deskLeg}
                metalness={0.6}
                roughness={0.35}
              />
            </mesh>
          ))}
          <mesh position={[0, 0.18, 0]}>
            <boxGeometry args={[0.03, 0.03, 0.78]} />
            <meshStandardMaterial
              color={palette.deskLeg}
              metalness={0.6}
              roughness={0.35}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Height of the ball above the table centre line, `u` = 0 at the hitter's bat → 1 at the receiver's. */
function arc(u) {
  const bounce = 0.68;
  if (u < bounce) {
    const s = u / bounce;
    return BAT_Y + (TOP + 0.02 - BAT_Y) * s + 0.22 * 4 * s * (1 - s);
  }
  const s = (u - bounce) / (1 - bounce);
  return TOP + 0.02 + (BAT_Y - TOP - 0.02) * s + 0.12 * 4 * s * (1 - s);
}

/** Rallies once both players have arrived; a lone player bounces the ball on their side. */
function Ball() {
  const presence = useContext(BreakPresence);
  const ball = useRef(null);
  const shadow = useRef(null);
  useFrame(({ clock }) => {
    const m = ball.current;
    if (!m) return;
    const a = presence.has('pingpong-0');
    const b = presence.has('pingpong-1');
    m.visible = a || b;
    if (shadow.current) shadow.current.visible = m.visible;
    if (!m.visible) return;
    const f = (clock.elapsedTime / RALLY_PERIOD) % 1;
    if (a && b) {
      const out = f < 0.5; // side 0 → side 1
      const u = (out ? f : f - 0.5) * 2;
      m.position.set(
        (out ? -1 : 1) * BAT_X * (1 - 2 * u),
        arc(u),
        0.05 * Math.sin(f * Math.PI * 2)
      );
    } else {
      // practice: tap the ball down onto your own half and catch it on the bat
      const side = a ? -1 : 1;
      const g = (f + (a ? 0 : 0.5)) % 1;
      const u = g < 0.5 ? g * 2 : (1 - g) * 2;
      m.position.set(
        side * (BAT_X - 0.08 * u),
        BAT_Y + (TOP + 0.02 - BAT_Y) * Math.sin((u * Math.PI) / 2),
        0
      );
    }
    if (shadow.current)
      shadow.current.position.set(m.position.x, TOP + 0.002, m.position.z);
  });
  return (
    <group userData={{ live: true }}>
      <mesh ref={ball} castShadow visible={false}>
        <sphereGeometry args={[0.034, 16, 12]} />
        <meshStandardMaterial
          color="#ff9447"
          emissive="#ff8a3d"
          emissiveIntensity={0.5}
          roughness={0.35}
        />
      </mesh>
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <circleGeometry args={[0.03, 14]} />
        <meshBasicMaterial
          color="#10213d"
          transparent
          opacity={0.35}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function BatRack(props) {
  return (
    <group {...props}>
      <RoundedBox args={[0.5, 0.36, 0.04]} radius={0.012} castShadow>
        <meshStandardMaterial color="#b89470" roughness={0.6} />
      </RoundedBox>
      {[-0.12, 0.12].map((x, i) => (
        <group
          key={x}
          position={[x, 0.02, 0.04]}
          rotation={[Math.PI / 2, 0, i ? 0.25 : -0.25]}
        >
          <mesh>
            <cylinderGeometry args={[0.075, 0.075, 0.012, 24]} />
            <meshStandardMaterial color={i ? '#1d1f24' : '#d6453d'} roughness={0.6} />
          </mesh>
          <mesh position={[0, 0, 0.11]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.013, 0.015, 0.09, 8]} />
            <meshStandardMaterial color="#c9a27e" roughness={0.6} />
          </mesh>
        </group>
      ))}
      {/* spare balls */}
      {[-0.16, -0.11, -0.06].map((x) => (
        <mesh key={x} position={[x + 0.2, -0.14, 0.045]}>
          <sphereGeometry args={[0.022, 12, 10]} />
          <meshStandardMaterial
            color={x === -0.11 ? '#ff8a5c' : '#ffffff'}
            roughness={0.3}
          />
        </mesh>
      ))}
    </group>
  );
}

export function PlayZone({ tableZ, ...props }) {
  const board = useMemo(() => scoreboardTexture(), []);
  return (
    <group {...props}>
      {/* court mat */}
      <RoundedBox
        args={[PINGPONG_HALF * 2 + 0.9, 0.012, 2.3]}
        radius={0.006}
        position={[0, 0.006, tableZ]}
        receiveShadow
      >
        <meshStandardMaterial color="#c9d6cf" roughness={1} />
      </RoundedBox>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, 0.013, tableZ + s * 1.05]}>
          <boxGeometry args={[PINGPONG_HALF * 2 + 0.6, 0.002, 0.03]} />
          <meshBasicMaterial color="#f4f2ee" />
        </mesh>
      ))}
      <group position={[0, 0, tableZ]}>
        <Table />
        <Ball />
      </group>
      {/* wall: scoreboard and bats */}
      <mesh position={[-0.35, 1.85, 0.03]}>
        <planeGeometry args={[1.0, 0.5]} />
        <meshBasicMaterial map={board} toneMapped={false} transparent />
      </mesh>
      <BatRack position={[0.75, 1.55, 0.04]} />
    </group>
  );
}

/** Bar-height round table for the coffee corner. */
export function HighTable(props) {
  return (
    <group {...props}>
      <mesh position={[0, 0.01, 0]} receiveShadow>
        <cylinderGeometry args={[0.22, 0.24, 0.02, 28]} />
        <meshStandardMaterial color={palette.deskLeg} metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.42, 0]} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 0.82, 10]} />
        <meshStandardMaterial color={palette.deskLeg} metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.84, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.32, 0.32, 0.035, 36]} />
        <meshStandardMaterial color={palette.deskTop} roughness={0.45} />
      </mesh>
    </group>
  );
}
