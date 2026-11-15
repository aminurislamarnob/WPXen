import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OfficeScene } from '../src/components/office/scene/OfficeScene.jsx';
import { subscribePreview } from '../src/lib/office/preview.js';
import { officeInRoom, roomTheme } from '../src/lib/office/scene/rooms.js';
import { PREVIEW_HOURS } from '../src/lib/office/scene/daylight.js';
import '../src/index.css';

// ── Office sandbox (dev only) ────────────────────────────────
// The Office scene on its own page, without Electron, so an environment can
// be reviewed in any browser — headless Chrome included — and several can be
// reviewed at once. Served by `npm run vite` at
//   http://localhost:5173/dev/office-sandbox.html?env=island&hour=golden
// Query: env (an environment id), hour (a number or dawn/day/golden/night;
// omitted = the real clock), room (claude | antigravity), mode (still | cycle
// | demo), zoom (mouse-wheel steps once loaded: positive zooms out, negative
// in — the wide shot of the world is around zoom=12). `demo` plays a
// scripted run of agent moments on top of the still preview — an arrival at
// 1.5 s, a finished turn at 3 s, an error at 4.5 s, a wait at 6 s, a
// departure at 7.5 s — so reactions can be caught on screenshots taken at
// those times. Every selection (a click on an agent or on the world object
// standing in for one) is logged as `[sandbox] select {...}`.
// `thumb=1` is the Settings picker's preview shot: no floating labels, and no
// agent in error, so every world shows its fair-weather self (the shots live
// in src/assets/office-environments/, captured at 1280×720, zoom=3, scaled
// to 320×180 WebP).
// `window.__officeSandboxSetEnv('space')` switches the world in place, the way
// the Settings picker does (the old world unmounts, the new one loads). Never
// part of the app bundle: vite builds index.html only.

const q = new URLSearchParams(location.search);
const hourParam = q.get('hour');
const hour =
  hourParam == null ? null : (PREVIEW_HOURS[hourParam] ?? (Number(hourParam) || 0));
const room = roomTheme(q.get('room') ?? 'claude');
const mode = q.get('mode') ?? 'still';
const zoomSteps = Number(q.get('zoom') ?? 0);
const thumb = q.get('thumb') === '1';

if (thumb) {
  const style = document.createElement('style');
  style.textContent = '.label-layer { display: none !important; }';
  document.head.append(style);
}

/** For a thumbnail: the same room, with every agent in error back at work. */
function calm(office) {
  const sessions = Object.fromEntries(
    Object.entries(office.sessions).map(([pid, s]) => [
      pid,
      s.state === 'error' ? { ...s, state: 'working' } : s,
    ])
  );
  return { ...office, sessions };
}

/** The scripted moments of `mode=demo`, applied to the still preview. */
function demoStep(office, step) {
  const sessions = { ...office.sessions };
  const pids = Object.keys(sessions)
    .map(Number)
    .filter((pid) => sessions[pid].agent !== 'antigravity');
  const set = (pid, patch) => {
    if (sessions[pid]) sessions[pid] = { ...sessions[pid], ...patch };
  };
  if (step >= 1)
    sessions[9001] = {
      ...sessions[pids[0]],
      pid: 9001,
      sessionId: 'demo-arrival',
      title: 'Just arrived',
      state: 'working',
      currentTool: 'Read',
      startedAt: Date.now(),
      subagents: {},
    };
  if (step >= 2)
    set(
      pids.find((p) => sessions[p].state === 'working'),
      { state: 'idle' }
    );
  if (step >= 3)
    set(
      pids.find((p) => sessions[p].state === 'thinking'),
      { state: 'error' }
    );
  if (step >= 4)
    set(
      pids.find((p) => sessions[p].state === 'idle'),
      { state: 'waiting_on_user' }
    );
  if (step >= 5) set(pids[pids.length - 1], { state: 'ended' });
  return { ...office, sessions };
}

function Sandbox() {
  const [base, setBase] = useState(null);
  const [step, setStep] = useState(0);
  const [env, setEnv] = useState(q.get('env') ?? 'city');
  useEffect(() => {
    window.__officeSandboxSetEnv = setEnv;
    return () => delete window.__officeSandboxSetEnv;
  }, []);
  useEffect(() => subscribePreview(setBase, mode === 'cycle' ? 'cycle' : 'still'), []);
  useEffect(() => {
    if (!zoomSteps) return;
    // Wheel steps once the canvas exists and the camera has eased into its
    // framing (zooming earlier gets undone). In mode=demo the arrival at 1.5 s
    // can grow the room and re-frame, so wait past it there.
    const settle = mode === 'demo' ? 3200 : 2500;
    let timer;
    const start = Date.now();
    const tryZoom = () => {
      const canvas = document.querySelector('canvas');
      if (!canvas || Date.now() - start < settle) {
        timer = setTimeout(tryZoom, 100);
        return;
      }
      const r = canvas.getBoundingClientRect();
      for (let i = 0; i < Math.abs(zoomSteps); i++)
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: Math.sign(zoomSteps) * 200,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            bubbles: true,
            cancelable: true,
          })
        );
    };
    tryZoom();
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (mode !== 'demo') return;
    const ids = [1, 2, 3, 4, 5].map((n) => setTimeout(() => setStep(n), 1500 * n));
    return () => ids.forEach(clearTimeout);
  }, []);
  const office = useMemo(() => {
    if (!base) return null;
    const shown = mode === 'demo' ? demoStep(base, step) : base;
    return officeInRoom(thumb ? calm(shown) : shown, room.kind);
  }, [base, step]);
  if (!office) return null;
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <OfficeScene
        office={office}
        room={room}
        environment={env}
        hour={hour}
        // Logged, so a click on a character or a world object can be checked
        // headlessly (console.warn, which screenshot drivers already collect).
        onSelect={(focus) => console.warn('[sandbox] select', JSON.stringify(focus))}
      />
    </div>
  );
}

// A hot reload re-runs this module; reuse the root rather than mounting twice.
// StrictMode as in src/main.jsx, so effects mount, unmount and remount here
// exactly as they do in the app's dev build.
window.__officeSandboxRoot ??= createRoot(document.getElementById('root'));
window.__officeSandboxRoot.render(
  <StrictMode>
    <Sandbox />
  </StrictMode>
);
