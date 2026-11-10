import * as THREE from 'three';
import { hash } from './theme.js';

// ── Procedural screen & decor textures ───────────────────────
// Drawn once on a canvas and cached. Screens use token bars rather than
// literal text: at office distance they read as real code instead of noise.
// Needs a DOM canvas, so this module is renderer-only and untested — the dev
// Preview is how it's reviewed. Ported pixel-faithful from the source scene.

/** @typedef {'code'|'terminal'|'design'|'dashboard'|'browser'} ScreenKind */

const cache = new Map();

function make(key, w, h, draw) {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  cache.set(key, tex);
  return tex;
}

function rand(seed) {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
    return ((s >>> 0) % 10000) / 10000;
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

const syntax = [
  '#c792ea',
  '#82aaff',
  '#c3e88d',
  '#f78c6c',
  '#89ddff',
  '#ffcb6b',
  '#d4d4d8',
  '#d4d4d8',
  '#d4d4d8',
];

function codeLines(ctx, x0, y0, w, h, seed, lineH = 14) {
  const r = rand(seed);
  let indent = 0;
  for (let y = y0, n = 1; y < y0 + h - lineH; y += lineH, n++) {
    ctx.fillStyle = '#4b5263';
    ctx.fillRect(x0, y + 4, n >= 10 ? 12 : 7, 5);
    if (r() < 0.12) continue;
    if (r() < 0.25 && indent < 4) indent++;
    else if (r() < 0.25 && indent > 0) indent--;
    let x = x0 + 26 + indent * 16;
    const tokens = 1 + Math.floor(r() * 5);
    for (let t = 0; t < tokens && x < x0 + w - 20; t++) {
      const tw = 10 + r() * 48;
      ctx.fillStyle = syntax[Math.floor(r() * syntax.length)];
      roundRect(ctx, x, y + 3, Math.min(tw, x0 + w - x - 8), 7, 3);
      x += tw + 6;
    }
  }
}

function drawCode(ctx, w, h, seed) {
  ctx.fillStyle = '#1e2028';
  ctx.fillRect(0, 0, w, h);
  // sidebar file tree
  ctx.fillStyle = '#181a21';
  ctx.fillRect(0, 0, 70, h);
  const r = rand(seed + 7);
  for (let y = 40; y < h; y += 16) {
    ctx.fillStyle = r() < 0.15 ? '#82aaff' : '#5c6370';
    roundRect(ctx, 10 + (r() < 0.4 ? 10 : 0), y, 24 + r() * 26, 6, 3);
  }
  // tabs
  ctx.fillStyle = '#16181e';
  ctx.fillRect(70, 0, w - 70, 26);
  ctx.fillStyle = '#1e2028';
  ctx.fillRect(76, 4, 92, 22);
  ctx.fillStyle = '#d97757';
  roundRect(ctx, 84, 11, 8, 8, 2);
  ctx.fillStyle = '#c8ccd4';
  roundRect(ctx, 98, 12, 54, 6, 3);
  ctx.fillStyle = '#5c6370';
  roundRect(ctx, 182, 12, 44, 6, 3);
  codeLines(ctx, 82, 34, w - 90, h - 34, seed);
}

function drawTerminal(ctx, w, h, seed) {
  ctx.fillStyle = '#121318';
  ctx.fillRect(0, 0, w, h);
  const r = rand(seed);
  for (let y = 16; y < h - 12; y += 15) {
    const prompt = r() < 0.22;
    let x = 14;
    if (prompt) {
      ctx.fillStyle = '#d97757';
      roundRect(ctx, x, y, 8, 7, 2);
      x += 14;
    }
    const parts = 1 + Math.floor(r() * 4);
    for (let p = 0; p < parts; p++) {
      const pw = 14 + r() * 60;
      ctx.fillStyle = prompt
        ? '#e5e7eb'
        : r() < 0.15
          ? '#86efac'
          : r() < 0.1
            ? '#fca5a5'
            : '#7c8494';
      roundRect(ctx, x, y, Math.min(pw, w - x - 12), 7, 3);
      x += pw + 7;
      if (x > w - 30) break;
    }
  }
}

function drawDesign(ctx, w, h, seed) {
  const r = rand(seed);
  ctx.fillStyle = '#2c2c2c';
  ctx.fillRect(0, 0, w, h);
  // canvas area
  ctx.fillStyle = '#e9e9ec';
  ctx.fillRect(64, 22, w - 128, h - 22);
  // layers & properties panels
  for (const px of [0, w - 64]) {
    ctx.fillStyle = '#2c2c2c';
    ctx.fillRect(px, 22, 64, h);
    for (let y = 34; y < h; y += 14) {
      ctx.fillStyle = r() < 0.2 ? '#0d99ff' : '#6b6b6b';
      roundRect(ctx, px + 8, y, 20 + r() * 30, 5, 2);
    }
  }
  // frames: phone screens + a desktop frame
  const accents = ['#5b6cff', '#d97757', '#14a38b', '#c2549d', '#e0a526'];
  const accent = accents[Math.floor(r() * accents.length)];
  const frames = [
    [86, 46, 70, 130],
    [168, 46, 70, 130],
    [250, 46, w - 336, 130],
  ];
  for (const [x, y, fw, fh] of frames) {
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x, y, fw, fh, 6);
    ctx.fillStyle = accent;
    roundRect(ctx, x + 6, y + 8, fw - 12, fh * 0.32, 4);
    ctx.fillStyle = '#d4d4d8';
    for (let i = 0; i < 4; i++)
      roundRect(ctx, x + 6, y + fh * 0.42 + i * 11, (fw - 12) * (0.5 + r() * 0.5), 5, 2);
    ctx.fillStyle = '#18181b';
    roundRect(ctx, x + 6, y + fh - 22, fw * 0.45, 13, 6);
  }
  // selection outline
  ctx.strokeStyle = '#0d99ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(166, 44, 74, 134);
  // top toolbar
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, w, 22);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i === 1 ? '#0d99ff' : '#8a8a8a';
    roundRect(ctx, 10 + i * 18, 7, 10, 9, 2);
  }
  // sticky note row below
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = ['#fde68a', '#bbf7d0', '#fbcfe8', '#bfdbfe'][i];
    roundRect(ctx, 90 + i * 60, 196, 50, 40, 3);
  }
}

function drawDashboard(ctx, w, h, seed) {
  const r = rand(seed);
  ctx.fillStyle = '#14151a';
  ctx.fillRect(0, 0, w, h);
  const tiles = [
    ['#5b6cff', 0.72],
    ['#14a38b', 0.54],
    ['#d97757', 0.38],
    ['#e0a526', 0.86],
  ];
  const tw = (w - 50) / 4;
  tiles.forEach(([c, v], i) => {
    const x = 10 + i * (tw + 10);
    ctx.fillStyle = '#1f2128';
    roundRect(ctx, x, 12, tw, 56, 6);
    ctx.fillStyle = '#6b7280';
    roundRect(ctx, x + 10, 22, tw * 0.4, 6, 3);
    ctx.fillStyle = '#f4f4f5';
    roundRect(ctx, x + 10, 36, tw * 0.5, 14, 4);
    ctx.fillStyle = c;
    roundRect(ctx, x + 10, 56, (tw - 20) * v, 5, 2);
  });
  // line chart
  ctx.fillStyle = '#1f2128';
  roundRect(ctx, 10, 80, w * 0.62, h - 92, 6);
  ctx.strokeStyle = '#2a2d36';
  ctx.lineWidth = 1;
  for (let y = 100; y < h - 20; y += 22) {
    ctx.beginPath();
    ctx.moveTo(20, y);
    ctx.lineTo(w * 0.62, y);
    ctx.stroke();
  }
  for (const [color, amp] of [
    ['#5b6cff', 1],
    ['#d97757', 0.6],
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    let v = 0.5;
    for (let x = 20; x < w * 0.62; x += 12) {
      v = Math.min(0.95, Math.max(0.1, v + (r() - 0.45) * 0.18 * amp));
      const y = h - 24 - v * (h - 130);
      x === 20 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // bar chart
  const bx = w * 0.62 + 20;
  ctx.fillStyle = '#1f2128';
  roundRect(ctx, bx, 80, w - bx - 10, h - 92, 6);
  for (let i = 0; i < 7; i++) {
    const bh = 20 + r() * (h - 140);
    ctx.fillStyle = i === 5 ? '#d97757' : '#3f4452';
    roundRect(
      ctx,
      bx + 14 + i * ((w - bx - 30) / 7),
      h - 22 - bh,
      (w - bx - 30) / 7 - 6,
      bh,
      3
    );
  }
}

function drawBrowser(ctx, w, h, seed) {
  const r = rand(seed);
  ctx.fillStyle = '#f4f4f5';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#e4e4e7';
  ctx.fillRect(0, 0, w, 24);
  for (const [i, c] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(12 + i * 12, 12, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 60, 6, w - 120, 12, 6);
  // WordPress-ish admin layout
  ctx.fillStyle = '#1d2327';
  ctx.fillRect(0, 24, 54, h);
  for (let y = 40; y < h; y += 16) {
    ctx.fillStyle = y === 72 ? '#3858e9' : '#8c8f94';
    roundRect(ctx, 10, y, 30, 6, 3);
  }
  ctx.fillStyle = '#3858e9';
  roundRect(ctx, 70, 40, w * 0.4, 70, 6);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 82, 56, w * 0.24, 10, 4);
  roundRect(ctx, 82, 74, w * 0.16, 7, 3);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, 70 + i * ((w - 90) / 3), 124, (w - 110) / 3, h - 140, 6);
    ctx.fillStyle = ['#fde68a', '#c7d2fe', '#bbf7d0'][i];
    roundRect(ctx, 78 + i * ((w - 90) / 3), 132, (w - 126) / 3, 40, 4);
    ctx.fillStyle = '#d4d4d8';
    for (let l = 0; l < 3; l++)
      roundRect(
        ctx,
        78 + i * ((w - 90) / 3),
        182 + l * 12,
        ((w - 126) / 3) * (0.5 + r() * 0.5),
        5,
        2
      );
  }
}

/** A screen texture. `variant` picks the layout seed so neighbouring desks differ. */
export function screenTexture(kind, variant) {
  const seed = hash(kind + variant) % 7;
  const tall = kind === 'code' || kind === 'terminal';
  return make(`${kind}:${seed}`, 512, tall ? 640 : 320, (ctx, w, h) => {
    if (kind === 'code') drawCode(ctx, w, h, seed + 3);
    else if (kind === 'terminal') drawTerminal(ctx, w, h, seed + 11);
    else if (kind === 'design') drawDesign(ctx, w, h, seed + 5);
    else if (kind === 'dashboard') drawDashboard(ctx, w, h, seed + 9);
    else drawBrowser(ctx, w, h, seed + 13);
  });
}

/** Whiteboard covered in wireframes, flow arrows and sticky notes. */
export function whiteboardTexture() {
  return make('whiteboard', 1024, 512, (ctx, w, h) => {
    ctx.fillStyle = '#fbfbfa';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#2b2f38';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    const box = (x, y, bw, bh) => {
      ctx.strokeRect(x, y, bw, bh);
    };
    // user flow
    const nodes = [
      [60, 70],
      [270, 70],
      [480, 70],
      [690, 70],
    ];
    nodes.forEach(([x, y], i) => {
      box(x, y, 150, 96);
      ctx.fillStyle = '#2b2f38';
      ctx.fillRect(x + 16, y + 18, 70, 8);
      ctx.fillRect(x + 16, y + 36, 110, 5);
      ctx.fillRect(x + 16, y + 48, 90, 5);
      if (i < nodes.length - 1) {
        ctx.beginPath();
        ctx.moveTo(x + 156, y + 48);
        ctx.lineTo(x + 204, y + 48);
        ctx.lineTo(x + 194, y + 40);
        ctx.moveTo(x + 204, y + 48);
        ctx.lineTo(x + 194, y + 56);
        ctx.stroke();
      }
    });
    // phone wireframes
    for (let i = 0; i < 3; i++) {
      const x = 70 + i * 150;
      box(x, 220, 110, 220);
      ctx.strokeRect(x + 12, 240, 86, 60);
      ctx.beginPath();
      ctx.moveTo(x + 12, 240);
      ctx.lineTo(x + 98, 300);
      ctx.moveTo(x + 98, 240);
      ctx.lineTo(x + 12, 300);
      ctx.stroke();
      ctx.fillStyle = '#2b2f38';
      for (let l = 0; l < 4; l++)
        ctx.fillRect(x + 12, 318 + l * 18, 60 + ((l * 23) % 26), 5);
      ctx.strokeStyle = '#d97757';
      ctx.strokeRect(x + 12, 400, 86, 24);
      ctx.strokeStyle = '#2b2f38';
    }
    // sticky notes
    const notes = ['#fde68a', '#bbf7d0', '#fbcfe8', '#bfdbfe', '#fde68a', '#fed7aa'];
    notes.forEach((c, i) => {
      const x = 560 + (i % 3) * 140;
      const y = 230 + Math.floor(i / 3) * 130;
      ctx.save();
      ctx.translate(x + 55, y + 55);
      ctx.rotate((((i * 37) % 9) - 4) * 0.012);
      ctx.fillStyle = c;
      ctx.fillRect(-55, -55, 110, 110);
      ctx.fillStyle = 'rgba(43,47,56,0.65)';
      ctx.fillRect(-40, -30, 70, 6);
      ctx.fillRect(-40, -14, 56, 6);
      ctx.fillRect(-40, 2, 64, 6);
      ctx.restore();
    });
  });
}

/** Dusk city skyline seen through the office windows. */
export function skylineTexture() {
  return make('skyline', 1024, 512, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#9fb7d9');
    g.addColorStop(0.55, '#e8c9b5');
    g.addColorStop(1, '#f3d9c4');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const r = rand(42);
    for (const [layer, color, base] of [
      [0, '#b7b9c9', 0.55],
      [1, '#8e92a8', 0.68],
    ]) {
      let x = 0;
      while (x < w) {
        const bw = 40 + r() * 90;
        const bh = h * (0.18 + r() * (layer ? 0.32 : 0.42));
        ctx.fillStyle = color;
        ctx.fillRect(x, h * base - bh + h * 0.32, bw, bh + h);
        if (layer) {
          ctx.fillStyle = 'rgba(255, 228, 170, 0.75)';
          for (let wy = h * base - bh + h * 0.32 + 10; wy < h; wy += 16)
            for (let wx = x + 8; wx < x + bw - 10; wx += 14)
              if (r() < 0.3) ctx.fillRect(wx, wy, 6, 8);
        }
        x += bw + 4;
      }
    }
  });
}

/** Wall poster / neon artwork. */
export function posterTexture(kind) {
  return make(`poster:${kind}`, 256, 340, (ctx, w, h) => {
    if (kind === 'ship') {
      ctx.fillStyle = '#1d1f24';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#d97757';
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.4, 62, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f4f2ee';
      ctx.font =
        "800 46px -apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, sans-serif";
      ctx.textAlign = 'center';
      ctx.fillText('SHIP IT', w / 2, h * 0.8);
      ctx.font = '500 14px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = '#9aa0aa';
      ctx.fillText('git push --no-fear', w / 2, h * 0.88);
    } else if (kind === 'grid') {
      ctx.fillStyle = '#f4f2ee';
      ctx.fillRect(0, 0, w, h);
      const cols = ['#5b6cff', '#d97757', '#14a38b', '#e0a526', '#1d1f24', '#c2549d'];
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 3; x++) {
          ctx.fillStyle = cols[(x + y * 2) % cols.length];
          const s = 60;
          const px = 28 + x * 70;
          const py = 30 + y * 72;
          if ((x + y) % 2) roundRect(ctx, px, py, s, s, 30);
          else roundRect(ctx, px, py, s, s, 8);
        }
    } else {
      ctx.fillStyle = '#14151a';
      ctx.fillRect(0, 0, w, h);
      const sprite = [
        '..1111..',
        '.111111.',
        '11.11.11',
        '11111111',
        '1.1111.1',
        '1.1..1.1',
        '..1..1..',
      ];
      const px = 22;
      sprite.forEach((row, y) =>
        [...row].forEach((c, x) => {
          if (c === '1') {
            ctx.fillStyle = '#8b5cf6';
            ctx.fillRect(40 + x * px, 60 + y * px, px - 2, px - 2);
          }
        })
      );
      ctx.fillStyle = '#f4f2ee';
      ctx.font = '700 22px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('PLAYER 1 READY', w / 2, h * 0.85);
    }
  });
}

/** Light oak floor planks. Repeat-wrapped; set `repeat` to the floor size. */
export function woodTexture() {
  const tex = make('wood', 512, 512, (ctx, w, h) => {
    const r = rand(7);
    const plankH = h / 8;
    for (let row = 0; row < 8; row++) {
      let x = -((row * 97) % 180);
      while (x < w) {
        const pw = 160 + r() * 140;
        const shade = 0.94 + r() * 0.09;
        const base = [217, 199, 172].map((c) => Math.round(c * shade));
        ctx.fillStyle = `rgb(${base.join(',')})`;
        ctx.fillRect(x, row * plankH, pw, plankH);
        ctx.strokeStyle = 'rgba(120, 92, 60, 0.08)';
        ctx.lineWidth = 1;
        for (let g = 0; g < 5; g++) {
          const gy = row * plankH + 6 + r() * (plankH - 12);
          ctx.beginPath();
          ctx.moveTo(x, gy);
          ctx.bezierCurveTo(
            x + pw * 0.3,
            gy + r() * 4 - 2,
            x + pw * 0.7,
            gy + r() * 4 - 2,
            x + pw,
            gy
          );
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(90, 70, 50, 0.18)';
        ctx.fillRect(x + pw - 1, row * plankH, 1.5, plankH);
        x += pw;
      }
      ctx.fillStyle = 'rgba(90, 70, 50, 0.16)';
      ctx.fillRect(0, row * plankH, w, 1.5);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Team sign: colour swatch, project name and a live count line. */
export function signTexture(name, detail, color, alert) {
  return make(`sign:${name}:${detail}:${color}:${alert}`, 800, 220, (ctx, w, h) => {
    ctx.fillStyle = '#fbfaf7';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(38, 46, 52, 52, 14);
    ctx.fill();
    ctx.fillStyle = '#1d1f24';
    ctx.font =
      "700 76px -apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, sans-serif";
    ctx.textBaseline = 'middle';
    let label = name;
    while (ctx.measureText(label).width > w - 140 && label.length > 4)
      label = label.slice(0, -2);
    if (label !== name) label = label.slice(0, -1) + '…';
    ctx.fillText(label, 112, 74);
    ctx.font =
      "500 46px -apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, sans-serif";
    ctx.fillStyle = alert ? '#b45309' : '#868b95';
    ctx.fillText(detail, 40, 162);
  });
}

/** Lettered plate with the room's name, mounted high on the back wall. */
export function nameplateTexture(name, color) {
  return make(`nameplate:${name}:${color}`, 1024, 160, (ctx, w, h) => {
    ctx.fillStyle = '#1d1f24';
    roundRect(ctx, 0, 0, w, h, 24);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(86, h / 2, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f4f2ee';
    ctx.font =
      "700 84px -apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, sans-serif";
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 142, h / 2 + 4, w - 180);
  });
}

/** Flip scoreboard for the play zone. */
export function scoreboardTexture() {
  return make('scoreboard', 512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#1d1f24';
    roundRect(ctx, 0, 0, w, h, 28);
    ctx.font =
      "600 30px -apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#868b95';
    ctx.fillText('BREAK  POINT', w / 2, 40);
    for (const [i, n] of ['11', '09'].entries()) {
      const x = 46 + i * 236;
      ctx.fillStyle = '#2b2e35';
      roundRect(ctx, x, 70, 184, 150, 16);
      ctx.fillStyle = i ? '#ff8a5c' : '#f4f2ee';
      ctx.font = "700 120px 'SF Mono', ui-monospace, Menlo, monospace";
      ctx.fillText(n, x + 92, 150);
      ctx.fillStyle = '#1d1f24';
      ctx.fillRect(x, 144, 184, 4);
    }
  });
}
