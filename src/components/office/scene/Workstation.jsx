import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBox } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { Label } from './Label.jsx';
import { Character, STAND_HEIGHT } from './Character.jsx';
import { BreakPresence } from '../../../lib/office/scene/breaks.js';
import { StaticBatch } from './StaticBatch.jsx';
import {
  DeskLamp,
  DeskPlant,
  Display,
  Headphones,
  Laptop,
  MechanicalKeyboard,
  Mouse,
  Mug,
  Notebooks,
  OfficeChair,
} from './Props.jsx';
import {
  hash,
  lookFor,
  palette,
  stateColor,
  stateLabel,
} from '../../../lib/office/scene/theme.js';

// ── Workstation ──────────────────────────────────────────────
// A desk with its peripherals and, when a session occupies it, the character
// whose pose shows the Agent State. Interns (#183) and click-to-focus (#185)
// land in their own tickets; the Commuter stays ported whole as shared
// infrastructure — without a break spot (wired in #184) it keeps the
// character seated.

const DESK_TOP = 0.74;
const SEAT = 0.49;
const CHAR_SCALE = 1.22;
const STAND_Y = STAND_HEIGHT * CHAR_SCALE;
const WALK = 1.35; // units/s, strolling to a break
const RUN = 3.4; // units/s, hurrying back to work
/** Tags float just above the head, or above the alert bubble when waiting. */
const tagHeight = (state) =>
  state === 'waiting_on_user'
    ? 1.28
    : state === 'thinking'
      ? 1.3
      : state === 'error'
        ? 1.2
        : 1.1;

const ACTIVE = ['working', 'thinking', 'waiting_on_user', 'error'];

/** Screen content follows what the agent is doing; the seed keeps neighbours varied. */
function screenFor(state, tool, seed) {
  if (state === 'working' && tool) {
    if (/bash|terminal|shell|command/i.test(tool)) return 'terminal';
    if (/web|fetch|browser|chrome|search/i.test(tool)) return 'browser';
  }
  return ['code', 'code', 'design', 'dashboard', 'code', 'browser'][seed % 6];
}

const screenTint = {
  error: '#ffb4b4',
  waiting_on_user: '#ffe2b0',
};

const feltCache = new Map();
/** Team colour softened toward warm grey, like acoustic felt. */
function felt(accent) {
  let c = feltCache.get(accent);
  if (!c)
    feltCache.set(
      accent,
      (c =
        '#' +
        new THREE.Color(accent).lerp(new THREE.Color('#cfc8bc'), 0.38).getHexString())
    );
  return c;
}

function Desk({ accent, occupied }) {
  return (
    <group>
      <RoundedBox
        args={[1.5, 0.04, 0.78]}
        radius={0.015}
        position={[0, DESK_TOP - 0.02, 0.55]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={palette.deskTop} roughness={0.55} />
      </RoundedBox>
      {/* slim steel frame */}
      {[-1, 1].map((s) =>
        [0.24, 0.86].map((z) => (
          <mesh
            key={`${s}${z}`}
            position={[s * 0.69, (DESK_TOP - 0.04) / 2, z]}
            castShadow
          >
            <boxGeometry args={[0.035, DESK_TOP - 0.04, 0.035]} />
            <meshStandardMaterial
              color={palette.deskLeg}
              roughness={0.35}
              metalness={0.6}
            />
          </mesh>
        ))
      )}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.69, DESK_TOP - 0.06, 0.55]}>
          <boxGeometry args={[0.03, 0.03, 0.62]} />
          <meshStandardMaterial
            color={palette.deskLeg}
            roughness={0.35}
            metalness={0.6}
          />
        </mesh>
      ))}
      {/* felt modesty panel in the team colour */}
      <RoundedBox
        args={[1.32, 0.3, 0.03]}
        radius={0.012}
        position={[0, DESK_TOP - 0.22, 0.88]}
        castShadow
      >
        <meshStandardMaterial color={felt(accent)} roughness={1} />
      </RoundedBox>
      {/* felt desk mat under keyboard and mouse */}
      <RoundedBox
        args={[0.74, 0.004, 0.27]}
        radius={0.002}
        position={[0.08, DESK_TOP + 0.002, 0.37]}
        receiveShadow
      >
        <meshStandardMaterial color={occupied ? '#4a4d55' : '#8d9099'} roughness={1} />
      </RoundedBox>
    </group>
  );
}

function AgentTag({ name, state, tool, emphasis = false, onBreak }) {
  const waiting = state === 'waiting_on_user';
  return (
    <div
      className={`agent-tag ${waiting ? 'agent-tag--waiting' : ''} ${emphasis ? 'agent-tag--emphasis' : ''}`}
      style={{ '--tag': stateColor[state] }}
    >
      <span className="agent-tag__dot" />
      {waiting ? (
        <span className="agent-tag__label">Waiting on you</span>
      ) : (
        <>
          <span className="agent-tag__name">{name}</span>
          {state === 'working' && tool ? (
            <span className="agent-tag__tool">{tool}</span>
          ) : state !== 'idle' ? (
            <span className="agent-tag__tool">{stateLabel[state]}</span>
          ) : (
            onBreak && <span className="agent-tag__tool">On break</span>
          )}
        </>
      )}
    </div>
  );
}

// ── Commuting ────────────────────────────────────────────────
// Progress is a distance along the desk → break-spot route, so a character
// called back halfway simply turns round and runs the way it came.

const _a = new THREE.Vector2();

function pointAt(route, dist, out, dir) {
  for (let i = 1; i < route.length; i++) {
    const seg = route[i].distanceTo(route[i - 1]);
    if (dist <= seg || i === route.length - 1) {
      dir.subVectors(route[i], route[i - 1]).normalize();
      return out.copy(route[i - 1]).addScaledVector(dir, Math.min(dist, seg));
    }
    dist -= seg;
  }
  return out.copy(route[0]);
}

function dampAngle(from, to, lambda, dt) {
  const diff = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + diff * (1 - Math.exp(-lambda * dt));
}

function Commuter({ origin, route, spot, onSeated, children, ...props }) {
  const presence = useContext(BreakPresence);
  const invalidate = useThree((s) => s.invalidate);
  const group = useRef(null);
  const stride = useRef(0);
  // Keep the last route so a character can still find its way back once the break ends.
  const lastRoute = useRef(route);
  if (route) lastRoute.current = route;
  const path = useMemo(
    () =>
      lastRoute.current?.map(
        (p) => new THREE.Vector2(p.x - origin.x, p.z - origin.z)
      ) ?? [new THREE.Vector2(0, -0.08)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [route, origin.x, origin.z]
  );
  const length = useMemo(
    () => path.reduce((sum, p, i) => (i ? sum + p.distanceTo(path[i - 1]) : 0), 0),
    [path]
  );
  const progress = useRef(spot ? Infinity : 0); // characters already on break at load start there
  const hold = useRef(0);
  const first = useRef(true);
  const present = useRef(null);
  const [stance, setStance] = useState(spot ? 'standing' : 'seated');
  const [arrived, setArrived] = useState(!!spot);
  const dir = useMemo(() => new THREE.Vector2(0, 1), []);

  // Only a seat at the desk pulls the desk chair back; the sofa doesn't.
  useEffect(() => onSeated(stance === 'seated' && !arrived), [stance, arrived, onSeated]);
  useEffect(
    () => () => {
      if (present.current) presence.delete(present.current);
    },
    [presence]
  );

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const d = Math.min(dt, 0.1);
    const away = !!spot;
    const before = Math.min(progress.current, length);
    let s = before;
    let next;
    if (away) {
      // stand, push the chair in, then stroll off
      if (s === 0 && hold.current < 0.45) {
        hold.current += d;
        next = 'standing';
      } else if (s < length) {
        s = Math.min(length, s + WALK * d);
        next = 'walking';
      } else next = spot.seat !== undefined ? 'seated' : 'standing';
    } else {
      hold.current = 0;
      if (s > 0) {
        s = Math.max(0, s - RUN * d);
        next = 'running';
      } else next = 'seated';
    }
    progress.current = s;
    stride.current += Math.abs(s - before) * (next === 'running' ? 4.6 : 7.5);

    const p = pointAt(path, s, _a, dir);
    const atSpot = away && s >= length;
    const yaw =
      next === 'walking'
        ? Math.atan2(dir.x, dir.y)
        : next === 'running'
          ? Math.atan2(-dir.x, -dir.y)
          : atSpot
            ? spot.facing
            : 0;
    const y =
      next === 'seated'
        ? atSpot && spot.seat !== undefined
          ? spot.seat
          : SEAT
        : STAND_Y;
    if (first.current) {
      first.current = false;
      g.position.y = y;
      g.rotation.y = yaw;
    }
    g.position.x = p.x;
    g.position.z = p.y;
    g.position.y = THREE.MathUtils.damp(g.position.y, y, 12, d);
    g.rotation.y = dampAngle(g.rotation.y, yaw, next === 'running' ? 14 : 9, d);

    const here = atSpot ? spot.id : null;
    if (here !== present.current) {
      if (present.current) presence.delete(present.current);
      if (here) presence.add(here);
      present.current = here;
    }
    if (next !== stance) setStance(next);
    if (atSpot !== arrived) setArrived(atSpot);
    const settling =
      Math.abs(g.position.y - y) > 0.002 || Math.abs(Math.sin(g.rotation.y - yaw)) > 0.01;
    if (s !== before || settling || (next === 'standing' && !atSpot)) invalidate();
  });

  const activity =
    arrived && spot
      ? spot.activity === 'pingpong'
        ? { kind: 'pingpong', side: spot.id.endsWith('1') ? 1 : 0 }
        : spot.activity === 'lounge'
          ? { kind: 'lounge', sprawl: spot.id.includes('beanbag') }
          : { kind: spot.activity }
      : undefined;

  return (
    <group ref={group} {...props}>
      {children(stance, activity, stride)}
    </group>
  );
}

export function Workstation({
  session,
  accent,
  deskKey,
  origin,
  route = null,
  spot = null,
}) {
  const seed = hash(session?.sessionId ?? deskKey);
  const look = useMemo(
    () => lookFor(session?.sessionId ?? deskKey),
    [session?.sessionId, deskKey]
  );
  const [hover, setHover] = useState(false);
  const state = session?.state ?? null;
  const tool = session?.currentTool;
  const kind = screenFor(state, tool, seed);
  const sideKind = kind === 'code' ? 'terminal' : 'code';
  const decor = seed % 4;
  const lit = state !== null;
  const [seated, setSeated] = useState(true);

  return (
    <group>
      <StaticBatch version={`${deskKey}|${kind}|${state}|${seated && !!session}`}>
        <Desk accent={accent} occupied={lit} />

        {/* main display, angled so the camera can read it */}
        <Display
          position={[-0.5, DESK_TOP, 0.66]}
          rotation={[0, 1.75, 0]}
          kind={lit ? kind : 'dashboard'}
          variant={deskKey}
          scroll={state === 'working'}
          tint={lit ? screenTint[state] : '#2a2c33'}
        />
        <Laptop
          position={[0.38, DESK_TOP, 0.62]}
          rotation={[0, Math.PI + 0.35, 0]}
          kind={sideKind}
          variant={deskKey + 'lt'}
          angle={lit ? 1.85 : 0.05}
        />
        <MechanicalKeyboard position={[-0.04, DESK_TOP, 0.36]} accent={accent} />
        <Mouse position={[0.27, DESK_TOP, 0.38]} />
        <Mug
          position={[0.62, DESK_TOP, 0.32]}
          color={decor % 2 ? '#f4f2ee' : accent}
          steam={state === 'working' || state === 'thinking'}
        />
        {decor === 0 && <DeskPlant position={[-0.62, DESK_TOP, 0.88]} />}
        {decor === 1 && (
          <DeskLamp position={[-0.64, DESK_TOP, 0.86]} rotation={[0, -0.6, 0]} on={lit} />
        )}
        {decor === 2 && <Notebooks position={[0.58, DESK_TOP, 0.82]} />}
        {decor === 3 && !look.headphones && (
          <Headphones position={[0.6, DESK_TOP, 0.84]} rotation={[0, 0.4, 0]} />
        )}
        {decor === 3 && look.headphones && (
          <DeskPlant position={[0.62, DESK_TOP, 0.86]} pot={palette.potDark} />
        )}

        <OfficeChair
          position={[0, 0, session && seated ? -0.14 : 0.08]}
          rotation={[0, session && seated ? 0 : 0.35, 0]}
        />
      </StaticBatch>

      {session && (
        <Commuter
          origin={origin}
          route={route}
          spot={spot}
          onSeated={setSeated}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHover(true);
          }}
          onPointerOut={() => setHover(false)}
        >
          {(stance, activity, stride) => (
            <>
              <Character
                look={look}
                state={session.state}
                accent={accent}
                scale={CHAR_SCALE}
                floor={-SEAT / CHAR_SCALE}
                stance={stance}
                activity={activity}
                stride={stride}
              />
              {(ACTIVE.includes(session.state) || hover) && (
                <Label
                  position={[0, tagHeight(session.state) * CHAR_SCALE, 0]}
                  zIndexRange={[30, 0]}
                >
                  <AgentTag
                    name={session.title || session.name}
                    state={session.state}
                    tool={tool}
                    onBreak={session.onBreak}
                  />
                </Label>
              )}
            </>
          )}
        </Commuter>
      )}

      {/* Interns (subagents pulling up a chair) land with #183. */}
    </group>
  );
}
