import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  Environment,
  Lightformer,
  OrbitControls,
  OrthographicCamera,
  RoundedBox,
} from '@react-three/drei';
import {
  createAllocators,
  planFloor,
  routeToBreak,
} from '../../../lib/office/scene/layout.js';
import { frameRate, isBusy, isFarZoom } from '../../../lib/office/scene/pacing.js';
import { poseSignature } from '../../../lib/office/scene/memo.js';
import { focusKey, focusTarget } from '../../../lib/office/focus.js';
import { BreakAllocator, BreakPresence } from '../../../lib/office/scene/breaks.js';
import { BeanBag, Room } from './Room.jsx';
import { Label, LabelLayer } from './Label.jsx';
import { FloorPlant } from './Props.jsx';
import { Workstation } from './Workstation.jsx';
import { palette, teamColor } from '../../../lib/office/scene/theme.js';
import { signTexture } from '../../../lib/office/scene/textures.js';
import { daylightAt, hourOf } from '../../../lib/office/scene/daylight.js';
import { CAMERA_DISTANCE, World } from './World.jsx';
import './scene.css';

// ── Office scene ─────────────────────────────────────────────
// The canvas owner: orthographic isometric camera with orbit/zoom and an
// auto-framing rig, rendered on a demand frameloop that a FrameDriver ticks
// only as fast as the office needs (and not at all when the window is hidden).
// Clicking a character or intern focuses the camera on it; clicking empty
// floor (onPointerMissed) releases focus and re-frames the room.

const VIEW_DIR = new THREE.Vector3(1, 0.92, 1.12).normalize();
const NO_SELECT = () => {};
const _dir = new THREE.Vector3();

// ── Pods ─────────────────────────────────────────────────────

function PodZone({ pod, plan, breaks, focus, onSelect, far }) {
  const accent = teamColor(pod.projectKey);
  const carpet = useMemo(
    () => new THREE.Color(palette.rug).lerp(new THREE.Color(accent), 0.13),
    [accent]
  );
  const live = pod.desks.filter((d) => d.session).length;
  const waiting = pod.desks.filter((d) => d.session?.state === 'waiting_on_user').length;
  return (
    <group>
      <RoundedBox
        args={[pod.width - 0.5, 0.014, pod.depth - 0.2]}
        radius={0.006}
        position={[pod.x + pod.width / 2, 0.007, pod.z + pod.depth / 2 - 0.05]}
        receiveShadow
      >
        <meshStandardMaterial color={carpet} roughness={1} />
      </RoundedBox>
      <PodSign pod={pod} accent={accent} live={live} waiting={waiting} far={far} />
      {pod.nooks.map((n, i) => (
        <Nook key={i} x={n.x} z={n.z} seed={i + pod.projectKey.length} />
      ))}
      {pod.desks.map((d) => {
        const spot = d.session ? (breaks.get(d.session.pid) ?? null) : null;
        const route = spot
          ? routeToBreak(plan, { x: d.x, z: d.z, podX: pod.x }, spot)
          : null;
        return (
          <group key={d.key} position={[d.x, 0, d.z]}>
            <Workstation
              session={d.session}
              accent={accent}
              deskKey={d.key}
              origin={d}
              route={route}
              spot={spot}
              focus={focus}
              onSelect={onSelect}
            />
          </group>
        );
      })}
    </group>
  );
}

/** Break-out corner filling an unused desk slot. */
const Nook = memo(function Nook({ x, z, seed }) {
  return (
    <group position={[x, 0, z]}>
      {seed % 2 ? (
        <>
          <FloorPlant position={[-0.35, 0, 0.2]} size={0.95} />
          <BeanBag position={[0.35, 0, 0.75]} rotation={[0, -0.6, 0]} color="#c9a27e" />
        </>
      ) : (
        <>
          <BeanBag position={[-0.3, 0, 0.6]} rotation={[0, 0.5, 0]} color="#8a93a6" />
          <FloorPlant position={[0.4, 0, 0.15]} size={0.85} pot={palette.potDark} />
        </>
      )}
    </group>
  );
});

/** The sign draws only the pod's name and corner; the pod object is new every snapshot. */
const podSignEqual = (a, b) =>
  a.accent === b.accent &&
  a.live === b.live &&
  a.waiting === b.waiting &&
  a.far === b.far &&
  a.pod.projectKey === b.pod.projectKey &&
  a.pod.x === b.pod.x &&
  a.pod.z === b.pod.z;

/** Floor-standing team sign at the left end of the pod. */
const PodSign = memo(function PodSign({ pod, accent, live, waiting, far }) {
  const detail = `${live} agent${live === 1 ? '' : 's'}${waiting ? ` · ${waiting} waiting` : ''}`;
  const tex = useMemo(
    () => signTexture(pod.projectKey, detail, accent, waiting > 0),
    [pod.projectKey, detail, accent, waiting]
  );
  return (
    <group position={[pod.x + 0.38, 0, pod.z + 0.62]} rotation={[0, 0.55, 0]}>
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.18, 0.04, 28]} />
        <meshStandardMaterial color={palette.deskLeg} roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.6, 0]} castShadow>
        <cylinderGeometry args={[0.018, 0.018, 1.2, 10]} />
        <meshStandardMaterial color={palette.deskLeg} roughness={0.4} metalness={0.5} />
      </mesh>
      <RoundedBox
        args={[1.6, 0.46, 0.03]}
        radius={0.014}
        position={[0, 1.4, 0]}
        castShadow
      >
        <meshStandardMaterial color="#fbfaf7" roughness={0.5} />
      </RoundedBox>
      <mesh position={[0, 1.4, 0.0155]}>
        <planeGeometry args={[1.58, 0.44]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
      <mesh position={[0, 1.638, 0]}>
        <boxGeometry args={[1.6, 0.016, 0.032]} />
        <meshBasicMaterial color={accent} toneMapped={false} />
      </mesh>
      {/* When zoomed out the sign is too small to read, so float a crisp label at its top. */}
      {far && (
        <Label position={[0, 1.7, 0]} zIndexRange={[10, 0]}>
          <div className="pod-label" style={{ '--team': accent }}>
            <span className="pod-label__swatch" />
            <span className="pod-label__name">{pod.projectKey}</span>
            {waiting > 0 && (
              <span className="pod-label__count">
                <b>{waiting} waiting</b>
              </span>
            )}
          </div>
        </Label>
      )}
    </group>
  );
}, podSignEqual);

// ── Camera ───────────────────────────────────────────────────

function roomCenter(plan) {
  return new THREE.Vector3(
    (plan.minX + plan.maxX + 1) / 2,
    0.4,
    (plan.minZ + plan.maxZ + 1) / 2
  );
}

/**
 * Frames the room exactly: projects its bounding box into the default view and
 * returns the zoom (px per unit) and aim point that fill the free viewport.
 */
function frameRoom(plan, width, height, inset) {
  const cam = new THREE.OrthographicCamera();
  cam.position.copy(VIEW_DIR);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const box = new THREE.Box3(
    new THREE.Vector3(plan.minX - 0.15, -0.4, plan.minZ - 0.15),
    new THREE.Vector3(plan.maxX + 1, 3.1, plan.maxZ + 1)
  );
  const ext = new THREE.Box3();
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z
    );
    ext.expandByPoint(p.applyMatrix4(cam.matrixWorldInverse));
  }
  const freeW = width - inset.right - 48;
  const freeH = height - inset.top - 32;
  const zoom = Math.min(freeW / (ext.max.x - ext.min.x), freeH / (ext.max.y - ext.min.y));
  // Camera-space centre of the room, shifted so it lands in the middle of the free area.
  const center = ext.getCenter(new THREE.Vector3());
  center.x += inset.right / 2 / zoom;
  center.y += inset.top / 2 / zoom;
  return { zoom, target: center.applyMatrix4(cam.matrixWorld), cam };
}

function CameraRig({ room, plan, breaks, focus, insetRight }) {
  const { camera, size, controls, invalidate } = useThree();
  const goal = useRef(null);
  // Switching rooms re-frames even when both rooms happen to be the same size.
  const boundsKey = `${room},${plan.minX},${plan.maxX},${plan.minZ},${plan.maxZ},${size.width},${size.height},${insetRight}`;
  // plan is new every snapshot; the framing only depends on what boundsKey names.
  const frame = useMemo(
    () => frameRoom(plan, size.width, size.height, { right: insetRight, top: 72 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boundsKey]
  );
  const aimKey = focusKey(focus, breaks);

  useEffect(() => {
    const p = focusTarget(plan, focus, breaks);
    if (!p) {
      // No focus (or it was released): back to the auto-framed room.
      goal.current = { target: frame.target, zoom: frame.zoom };
    } else {
      const zoom = Math.max(frame.zoom * 2.6, 80);
      // Keep the focused agent centred in the area beside the side panel.
      const right = new THREE.Vector3()
        .setFromMatrixColumn(frame.cam.matrixWorld, 0)
        .multiplyScalar(insetRight / 2 / zoom);
      goal.current = { target: new THREE.Vector3(p.x, p.y, p.z).add(right), zoom };
    }
    invalidate();
    // plan changes every tick; only re-aim when the room or the focus changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, aimKey]);

  useFrame((_, dt) => {
    const g = goal.current;
    if (!g || !controls) return;
    const k = 1 - Math.exp(-dt * 5);
    controls.target.lerp(g.target, k);
    camera.zoom += (g.zoom - camera.zoom) * k;
    const dist = camera.position.distanceTo(controls.target);
    _dir.copy(camera.position).sub(controls.target).normalize();
    camera.position.copy(controls.target).add(_dir.multiplyScalar(dist));
    camera.updateProjectionMatrix();
    controls.update();
    if (
      controls.target.distanceTo(g.target) < 0.01 &&
      Math.abs(camera.zoom - g.zoom) < 0.05
    )
      goal.current = null;
    else invalidate();
  });

  return null;
}

/**
 * Shadows only change when agents change pose, so the shadow map re-renders for
 * a moment after a pose change instead of on every frame. `version` is the
 * pose signature, not the office: snapshots arrive faster than the window, and
 * keying on them kept the timer from ever expiring.
 */
function ShadowBudget({ version }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.shadowMap.autoUpdate = true;
    const id = setTimeout(() => {
      gl.shadowMap.autoUpdate = false;
      gl.shadowMap.needsUpdate = true;
    }, 1500);
    return () => clearTimeout(id);
  }, [gl, version]);
  return null;
}

/** Reports whether the camera is zoomed out past the point where in-world text is legible. */
function ZoomWatcher({ onChange }) {
  const last = useRef(null);
  useFrame(({ camera }) => {
    const far = isFarZoom(camera.zoom);
    if (far !== last.current) {
      last.current = far;
      onChange(far);
    }
  });
  return null;
}

/** Drives the demand-mode render loop: brisk while agents move, slow when the office is calm. */
function FrameDriver({ fps }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!fps) return;
    const id = setInterval(() => invalidate(), 1000 / fps);
    return () => clearInterval(id);
  }, [fps, invalidate]);
  return null;
}

/** Lights only follow the room's bounds and the time of day; plan itself is new every snapshot. */
const lightsEqual = (a, b) =>
  a.look === b.look &&
  a.plan.minX === b.plan.minX &&
  a.plan.maxX === b.plan.maxX &&
  a.plan.minZ === b.plan.minZ &&
  a.plan.maxZ === b.plan.maxZ;

/** How far the key light sits from the room centre, along its direction. */
const KEY_DISTANCE = 40;

/**
 * The room's light at this moment of the local day (lib/office/scene/
 * daylight.js): the sun — or the moon — as the shadow-casting key light, a
 * hemisphere for sky and floor bounce (warm office lighting at night), and the
 * studio Lightformers for reflections, dimmed after dark. Memoised on the
 * bounds and the look: drei's Environment re-captures its cube map whenever
 * its children change identity, which used to happen on every snapshot.
 */
const Lights = memo(function Lights({ plan, look }) {
  const c = roomCenter(plan);
  const span = Math.max(plan.maxX - plan.minX, plan.maxZ - plan.minZ) * 0.75 + 4;
  const light = useRef(null);
  const gl = useThree((s) => s.gl);
  const [kx, ky, kz] = look.keyDir;
  useEffect(() => {
    const l = light.current;
    if (!l) return;
    l.target.position.copy(c);
    l.target.updateMatrixWorld();
    const cam = l.shadow.camera;
    cam.left = cam.bottom = -span;
    cam.right = cam.top = span;
    cam.near = 1;
    cam.far = KEY_DISTANCE * 2.5;
    cam.updateProjectionMatrix();
    // The sun moved: the frozen shadow map needs one fresh pass.
    gl.shadowMap.needsUpdate = true;
  });
  return (
    <>
      <hemisphereLight args={[look.hemiSky, look.hemiGround, look.hemiIntensity]} />
      <ambientLight intensity={look.ambient} />
      <directionalLight
        ref={light}
        position={[
          c.x + kx * KEY_DISTANCE,
          c.y + ky * KEY_DISTANCE,
          c.z + kz * KEY_DISTANCE,
        ]}
        intensity={look.sunIntensity}
        color={look.sun}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
      <directionalLight
        position={[c.x + 10, 8, c.z + 12]}
        intensity={look.fill}
        color="#dfe8ff"
      />
      <Environment resolution={128} frames={1} environmentIntensity={look.env}>
        <Lightformer form="rect" intensity={2} position={[0, 5, -6]} scale={[10, 3, 1]} />
        <Lightformer
          form="rect"
          intensity={1.2}
          position={[-6, 3, 0]}
          rotation-y={Math.PI / 2}
          scale={[8, 2, 1]}
          color="#ffe9d6"
        />
        <Lightformer form="ring" intensity={1.5} position={[5, 6, 5]} scale={2} />
      </Environment>
    </>
  );
}, lightsEqual);

/**
 * The viewer's local hour, re-read once a minute and whenever the window
 * comes back into view, or `override` (the dev Preview's time presets).
 * @param {number | null} override
 * @param {boolean} visible
 */
function useLocalHour(override, visible) {
  const [hour, setHour] = useState(() => hourOf(new Date()));
  useEffect(() => {
    if (override != null || !visible) return;
    setHour(hourOf(new Date()));
    const id = setInterval(() => setHour(hourOf(new Date())), 60_000);
    return () => clearInterval(id);
  }, [override, visible]);
  return override ?? hour;
}

// ── Scene ────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {object} props.office The sessions in the room on screen.
 * @param {object} props.room The RoomTheme to render.
 * @param {{ pid: number, subagentId?: string } | null} [props.focus] The
 *   session or intern the camera is on (see lib/office/focus.js).
 * @param {(focus: object | null) => void} [props.onSelect] Called with the
 *   clicked character or intern, or null when the click hit empty floor.
 * @param {number} [props.insetRight] Pixels on the right covered by HUD panels;
 *   the camera frames the remaining area.
 * @param {number | null} [props.hour] Local hour to light the office for;
 *   null follows the real clock (the dev Preview passes its presets).
 */
export function OfficeScene({
  office,
  room,
  focus = null,
  onSelect = NO_SELECT,
  insetRight = 0,
  hour = null,
}) {
  // Each room keeps its own sticky desk slots and break spots, so switching
  // back finds everyone where they were — at their desk or in the lounge.
  const rooms = useRef(new Map());
  let slots = rooms.current.get(room.kind);
  if (!slots)
    rooms.current.set(
      room.kind,
      (slots = { desks: createAllocators(), breaks: new BreakAllocator() })
    );
  const { desks, breaks: breakAlloc } = slots;
  const plan = useMemo(() => planFloor(office, desks), [office, desks]);
  const breaks = useMemo(
    () => breakAlloc.sync(Object.values(office.sessions), plan.amenities.spots),
    [office, plan, breakAlloc]
  );
  const presence = useMemo(() => new Set(), []);

  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const localHour = useLocalHour(hour, visible);
  const look = useMemo(() => daylightAt(localHour), [localHour]);

  // a rally needs smooth frames
  const rally = [...breaks.values()].some((s) => s.activity === 'pingpong');
  const fps = frameRate({ visible, busy: isBusy(office), rally });
  const [far, setFar] = useState(true);
  const center = roomCenter(plan);
  const poses = poseSignature(plan, breaks);

  const labelLayer = useRef(null);

  return (
    <LabelLayer.Provider value={labelLayer}>
      <div ref={labelLayer} className="label-layer" />
      <Canvas
        frameloop={visible ? 'demand' : 'never'}
        shadows="percentage"
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
        onPointerMissed={() => onSelect(null)}
      >
        <OrthographicCamera
          makeDefault
          position={center
            .clone()
            .add(VIEW_DIR.clone().multiplyScalar(CAMERA_DISTANCE))
            .toArray()}
          zoom={40}
          near={1}
          far={CAMERA_DISTANCE * 4}
        />
        <OrbitControls
          makeDefault
          target={center.toArray()}
          enableDamping={false}
          minPolarAngle={0.55}
          maxPolarAngle={1.2}
          minAzimuthAngle={0.12}
          maxAzimuthAngle={1.45}
          minZoom={12}
          maxZoom={260}
          screenSpacePanning
        />
        <CameraRig
          room={room.kind}
          plan={plan}
          breaks={breaks}
          focus={focus}
          insetRight={insetRight}
        />
        <FrameDriver fps={fps} />
        <ShadowBudget version={poses} />
        <ZoomWatcher onChange={setFar} />
        <Lights plan={plan} look={look} />
        <World plan={plan} kind={room.kind} look={look} />
        <BreakPresence.Provider value={presence}>
          <Room plan={plan} theme={room} />
          {plan.pods.map((pod) => (
            <PodZone
              key={pod.projectKey}
              pod={pod}
              plan={plan}
              breaks={breaks}
              focus={focus}
              onSelect={onSelect}
              far={far}
            />
          ))}
        </BreakPresence.Provider>
      </Canvas>
    </LabelLayer.Provider>
  );
}
