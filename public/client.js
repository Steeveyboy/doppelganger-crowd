// Doppelganger Crowd — ASCII isometric client
const socket = io();
const cv = document.getElementById('game'), ctx = cv.getContext('2d');
const $ = id => document.getElementById(id);

let cfg = null, me = { entityId: null, alive: false, tasks: [], cooldownUntil: 0 };
let round = { phase: 'playing', endsAt: 0, reveal: [] };
let strikesPending = [];   // [x, y, secondsLeft] from server
let snaps = [];             // [{recv, map: Map(id -> [x,y])}]
let effects = [];
let hoverId = null, mouse = { x: -9999, y: -9999 }, scale = 1;
let clockSkew = 0;          // serverSec - localSec
const INTERP_MS = 120;

// ---------- Look ----------
const BG = '#0a0a0a', FLOOR = '#444', EDGE = '#5a5a5a', BODY = '#c4c4c4';
const YOU = '#facc15', RED = '#ef4444', GREEN = '#4ade80', DIM = '#777';
const FS = 22, LH = 20;                      // font size / line height in logical px
const FONT = `bold ${FS}px "Courier New", ui-monospace, monospace`;
const TOP = 110;                             // headroom above the diamond's top corner
let CW = 13;                                 // glyph width, measured after init

// Side-profile sprites: [frame][line]
const SPRITES = {
  r: [[' o ', '/|>', '/ \\'], [' o ', '/|>', '| |']],
  l: [[' o ', '<|\\', '/ \\'], [' o ', '<|\\', '| |']],
};
const STATION_ART = {
  'Coffee':    [' ) ) ', '[___]D'],
  'Fountain':  [" .'. ", '(~~~)'],
  'Kiosk':     ['/^^^\\', '|[i]|'],
  'Bench':     ['|___|', '|   |'],
  'Gate':      ['|=|=|', '| | |'],
  'Statue':    [' _A_ ', ' | | ', '[___]'],
  'Food Cart': [' ____ ', '[_HOT]', ' o  o '],
};

// ---------- Isometric projection ----------
// World (x,y) is a square; on screen it becomes a diamond. Lower on screen = nearer the viewer.
let OX = 0;
const proj = (x, y) => [OX + (x - y), TOP + (x + y) / 2];
const unproj = (sx, sy) => { const px = sx - OX, py = sy - TOP; return { x: py + px / 2, y: py - px / 2 }; };

// ---------- Join ----------
$('joinForm').onsubmit = e => {
  e.preventDefault();
  socket.emit('join', $('name').value.trim());
  $('join').style.display = 'none';
  cv.focus();
};

socket.on('init', c => { cfg = c; OX = c.H; resize(); });
socket.on('round', r => { round = { reveal: [], ...r }; effects = []; });
socket.on('you', y => { me = y; renderHud(); });
socket.on('msg', toast);
socket.on('s', s => {
  clockSkew = s.t / 1000 - Date.now() / 1000;
  snaps.push({ recv: performance.now(), map: new Map(s.e.map(([id, x, y]) => [id, [x, y]])) });
  if (snaps.length > 10) snaps.shift();
  strikesPending = s.st || [];
  for (const ev of s.ev) {
    if (ev.type === 'caught') effects.push({ ...ev, until: performance.now() + 3000 });
    if (ev.type === 'boom') effects.push({ ...ev, start: performance.now(), until: performance.now() + 900 });
  }
  $('scores').innerHTML = s.sb.map(p => `<div class="${p.alive ? '' : 'dead'}">${esc(p.name)} : ${p.score}</div>`).join('');
});

function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let toastTimer;
function toast(m) { const t = $('toast'); t.textContent = m; t.style.opacity = 1; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.opacity = 0, 2800); }

function renderHud() {
  $('tasks').innerHTML = me.tasks.map((t, i) => `<div class="task ${i === 0 ? 'next' : ''}">${i === 0 ? '&gt; ' : '- '}${esc(t)}</div>`).join('');
}

// ---------- Layout ----------
let LW = 2000, LHT = 1150;
function resize() {
  if (!cfg) return;
  LW = cfg.W + cfg.H; LHT = (cfg.W + cfg.H) / 2 + TOP + 30;
  scale = Math.min(innerWidth / LW, innerHeight / LHT);
  cv.width = LW * scale * devicePixelRatio; cv.height = LHT * scale * devicePixelRatio;
  cv.style.width = LW * scale + 'px'; cv.style.height = LHT * scale + 'px';
  cv.style.marginTop = (innerHeight - LHT * scale) / 2 + 'px';
  ctx.font = FONT; CW = ctx.measureText('M').width;
}
addEventListener('resize', resize);
function toScreen(ev) { const r = cv.getBoundingClientRect(); return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale }; }

// ---------- Input ----------
const keys = new Set();
let lastSent = '';
function sendInput() {
  // Keys are screen-relative; convert to world axes (screen right = world +x -y, screen down = world +x +y).
  const sx = (keys.has('d') || keys.has('arrowright')) - (keys.has('a') || keys.has('arrowleft'));
  const sy = (keys.has('s') || keys.has('arrowdown')) - (keys.has('w') || keys.has('arrowup'));
  const inp = { dx: Math.sign(sx + sy), dy: Math.sign(sy - sx), slow: keys.has('c') };
  const k = JSON.stringify(inp);
  if (k !== lastSent) { lastSent = k; socket.emit('input', inp); }
}
addEventListener('keydown', e => {
  if ($('join').style.display !== 'none') return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); tryTag(); return; }
  if (k === 'shift') { if (!e.repeat) tryDash(); return; }
  if (k === 'r') { if (!e.repeat) tryStrike(); return; }
  if (k.startsWith('arrow')) e.preventDefault();
  keys.add(k); sendInput();
});
addEventListener('keyup', e => { keys.delete(e.key.toLowerCase()); sendInput(); });
addEventListener('blur', () => { keys.clear(); sendInput(); });
cv.addEventListener('mousemove', e => { mouse = toScreen(e); });
cv.addEventListener('mousedown', e => {
  if (e.button === 0) {
    const s = toScreen(e), w = unproj(s.x, s.y);
    w.x = Math.max(0, Math.min(cfg.W, w.x)); w.y = Math.max(0, Math.min(cfg.H, w.y));
    socket.emit('moveTo', w);
    effects.push({ type: 'click', x: w.x, y: w.y, until: performance.now() + 500 });
  }
  if (e.button === 2) tryTag();
});
cv.addEventListener('contextmenu', e => e.preventDefault());

function serverNow() { return Date.now() / 1000 + clockSkew; }
function tryDash() {
  if (!me.alive || serverNow() < me.dashReadyAt) return;
  socket.emit('dash');
}
function tryStrike() {
  if (!me.alive || !cfg || mouse.x < 0) return;
  if (serverNow() < me.strikeReadyAt) { toast('Airstrike is on cooldown.'); return; }
  if (me.score < cfg.strike.cost) { toast(`An airstrike costs ${cfg.strike.cost} points.`); return; }
  const w = unproj(mouse.x, mouse.y);
  socket.emit('strike', { x: Math.max(0, Math.min(cfg.W, w.x)), y: Math.max(0, Math.min(cfg.H, w.y)) });
}

function tryTag() {
  if (!hoverId || hoverId === me.entityId) return;
  if (Date.now() / 1000 + clockSkew < me.cooldownUntil) { toast('Tagging is locked - wait for the cooldown.'); return; }
  socket.emit('tag', hoverId);
}

// ---------- Rendering ----------
// Speed from the last 5 server snapshots (server ticks are exactly 50ms apart).
function snapSpeed(id) {
  if (snaps.length < 5) return 0;
  const p1 = snaps[snaps.length - 1].map.get(id), p0 = snaps[snaps.length - 5].map.get(id);
  return p1 && p0 ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 0.2 : 0;
}

function interpolated() {
  if (snaps.length === 0) return new Map();
  const rt = performance.now() - INTERP_MS;
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = 0; i < snaps.length - 1; i++) {
    if (snaps[i].recv <= rt && snaps[i + 1].recv >= rt) { a = snaps[i]; b = snaps[i + 1]; break; }
  }
  const f = b.recv === a.recv ? 1 : Math.max(0, Math.min(1, (rt - a.recv) / (b.recv - a.recv)));
  const out = new Map();
  for (const [id, [bx, by]] of b.map) {
    const pa = a.map.get(id);
    out.set(id, pa ? [pa[0] + (bx - pa[0]) * f, pa[1] + (by - pa[1]) * f] : [bx, by]);
  }
  return out;
}

const anim = new Map();   // id -> {x, y, face, dist, movedAt}

function bar(frac, n = 10) { const k = Math.round(Math.max(0, Math.min(1, frac)) * n); return '[' + '#'.repeat(k) + '-'.repeat(n - k) + ']'; }

function text(str, x, y, color) { ctx.fillStyle = color; ctx.fillText(str, x, y); }

// Draw stacked lines, bottom line sitting on (sx, sy). Blanks out what is behind it first.
function block(lines, sx, sy, color) {
  const w = Math.max(...lines.map(l => l.length)) * CW;
  ctx.fillStyle = BG; ctx.fillRect(sx - w / 2, sy - lines.length * LH, w, lines.length * LH);
  ctx.fillStyle = color;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], sx, sy - (lines.length - 1 - i) * LH);
}

function ring(cx, cy, r, n, ch, color, rot = 0) {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const a = rot + i / n * Math.PI * 2;
    const [sx, sy] = proj(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.fillText(ch, sx, sy + 6);
  }
}

function draw() {
  requestAnimationFrame(draw);
  if (!cfg) return;
  ctx.setTransform(scale * devicePixelRatio, 0, 0, scale * devicePixelRatio, 0, 0);
  ctx.fillStyle = BG; ctx.fillRect(0, 0, LW, LHT);
  ctx.font = FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  const t = performance.now();

  // floor: dots on the iso grid, slashes for the diamond's edges
  for (let x = 50; x < cfg.W; x += 50) for (let y = 50; y < cfg.H; y += 50) {
    const [sx, sy] = proj(x, y); text('.', sx, sy + 6, FLOOR);
  }
  for (let d = 0; d <= cfg.W; d += 20) {
    let p = proj(d, 0); text('\\', p[0], p[1] + 8, EDGE);
    p = proj(d, cfg.H); text('\\', p[0], p[1] + 8, EDGE);
    p = proj(0, d); text('/', p[0], p[1] + 8, EDGE);
    p = proj(cfg.W, d); text('/', p[0], p[1] + 8, EDGE);
  }

  const pos = interpolated();
  const mine = me.alive ? pos.get(me.entityId) : null;
  const nextTask = me.alive && me.tasks[0];

  // station zones (flat on the floor)
  for (const s of cfg.stations) {
    if (s.name === nextTask) ring(s.x, s.y, cfg.stationR + 4, 18, '*', YOU, t / 900);
    else ring(s.x, s.y, cfg.stationR, 14, ':', s.color);
  }
  // tag range
  if (mine) ring(mine[0], mine[1], cfg.tagRange, 40, '.', DIM);

  // pending airstrikes: everyone sees where, nobody sees who called it
  for (const [x, y, left] of strikesPending) {
    const urgent = left < 1 && Math.floor(t / 120) % 2;
    ring(x, y, cfg.strike.radius, 28, 'x', urgent ? '#ffffff' : RED, t / 700);
    ring(x, y, cfg.strike.radius * Math.max(0.05, left / cfg.strike.delay), 12, '.', RED);
  }

  // click markers (on the floor)
  effects = effects.filter(e => e.until > t);
  for (const e of effects) if (e.type === 'click') { const [sx, sy] = proj(e.x, e.y); text('+', sx, sy + 8, YOU); }

  // update animation state + find hover target
  hoverId = null; let best = 30;
  const things = [];
  for (const [id, [x, y]] of pos) {
    let a = anim.get(id);
    if (!a) { a = { x, y, face: Math.random() < 0.5 ? 'l' : 'r', dist: 0, movedAt: 0 }; anim.set(id, a); }
    const dx = x - a.x, dy = y - a.y, d = Math.hypot(dx, dy);
    if (d > 0.12) {
      a.dist += d; a.movedAt = t;
      const sdx = dx - dy;                       // screen-space horizontal motion
      if (Math.abs(sdx) > 0.15) a.face = sdx > 0 ? 'r' : 'l';
    }
    a.x = x; a.y = y; a.seen = t;
    const [sx, sy] = proj(x, y);
    const hd = Math.hypot(sx - mouse.x, (sy - LH * 1.5) - mouse.y);
    if (hd < best && id !== me.entityId) { best = hd; hoverId = id; }
    things.push({ kind: 'e', id, x, y, sx, sy, a });
  }
  for (const [id, a] of anim) if (t - a.seen > 2000) anim.delete(id);
  for (const s of cfg.stations) { const [sx, sy] = proj(s.x, s.y); things.push({ kind: 's', s, sx, sy }); }
  for (const e of effects) if (e.type === 'caught') { const [sx, sy] = proj(e.x, e.y); things.push({ kind: 'x', e, sx, sy }); }

  // painter's order: far (top of screen) first, near last
  things.sort((p, q) => p.sy - q.sy);
  const reveal = round.phase === 'intermission' ? new Map((round.reveal || []).map(r => [r.id, r.name])) : null;

  const labels = [];
  for (const th of things) {
    const { sx, sy } = th;
    if (th.kind === 's') {
      const art = STATION_ART[th.s.name] || ['[#]'];
      block(art, sx, sy + 4, th.s.color);
      labels.push([['[' + th.s.name.toUpperCase() + ']'], sx, sy + 4 - art.length * LH - 2, th.s.name === nextTask ? YOU : th.s.color]);
    } else if (th.kind === 'x') {
      block(['\\ /', ' X ', '/ \\'], sx, sy, RED);
      text(th.e.name, sx, sy - 3 * LH - 2, RED);
    } else {
      const walking = t - th.a.movedAt < 160;
      const frame = walking ? Math.floor(th.a.dist / 9) % 2 : 0;
      let color = BODY;
      if (th.id === me.entityId) color = YOU;
      if (reveal && reveal.has(th.id)) color = GREEN;
      if (th.id === hoverId) {
        const inRange = mine && Math.hypot(th.x - mine[0], th.y - mine[1]) <= cfg.tagRange;
        color = inRange ? RED : '#ffffff';
        text('[', sx - CW * 2.2, sy - LH, color); text(']', sx + CW * 2.2, sy - LH, color);
      }
      if (snapSpeed(th.id) > 120) {                     // dashing (or a hurried doppel) kicks up dust
        const back = th.a.face === 'r' ? -1 : 1;
        text('~', sx + back * CW * 2, sy - 2, DIM); text('~', sx + back * CW * 3, sy - LH * 0.4, '#555');
      }
      block(SPRITES[th.a.face][frame], sx, sy, color);
      if (th.id === me.entityId && round.phase === 'playing') {
        const now = serverNow();
        const ready = now >= me.dashReadyAt;
        const frac = now < me.dashUntil ? 1 : ready ? 1 : 1 - (me.dashReadyAt - now) / cfg.dash.cooldown;
        ctx.font = `bold ${FS * 0.7}px "Courier New", monospace`;
        text(now < me.dashUntil ? '>>>>>' : bar(frac, 5), sx, sy + LH * 0.75, ready || now < me.dashUntil ? YOU : DIM);
        ctx.font = FONT;
      }
      if (th.id === me.entityId) text('v', sx, sy - 3 * LH - 2, YOU);
      if (reveal && reveal.has(th.id)) text(reveal.get(th.id), sx, sy - 3 * LH - (th.id === me.entityId ? LH : 0) - 2, GREEN);
    }
  }
  for (const [x, y, left] of strikesPending) {
    const [sx, sy] = proj(x, y);
    block(['!! ' + left.toFixed(1) + ' !!'], sx, sy - 3 * LH, RED);
  }
  for (const e of effects) if (e.type === 'boom') {
    const k = (t - e.start) / 900;
    ring(e.x, e.y, e.r * (0.3 + k), 22, k < 0.5 ? '#' : '*', k < 0.5 ? '#fb923c' : '#9ca3af', k * 3);
    ring(e.x, e.y, e.r * (0.1 + k * 0.6), 12, '@', '#fde047', -k * 2);
    const [sx, sy] = proj(e.x, e.y);
    if (k < 0.6) block(['BOOM'], sx, sy - LH, '#fde047');
  }
  for (const l of labels) block(...l);   // station names always stay readable on top

  // status + banner
  const left = Math.max(0, Math.ceil(round.endsAt - (Date.now() / 1000 + clockSkew)));
  const cd = Math.max(0, Math.ceil(me.cooldownUntil - (Date.now() / 1000 + clockSkew)));
  let status = round.phase === 'playing'
    ? `[${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}]` + (cd ? ` tag locked ${cd}s` : '') + (me.alive ? '' : ' spectating')
    : `Next round in ${left}s`;
  if (me.alive && round.phase === 'playing') {
    const now = serverNow();
    const dLeft = Math.max(0, me.dashReadyAt - now), sLeft = Math.max(0, me.strikeReadyAt - now);
    status += `\nDASH   (Shift) ${bar(1 - dLeft / cfg.dash.cooldown)} ${dLeft ? Math.ceil(dLeft) + 's' : 'READY'}`;
    const canPay = me.score >= cfg.strike.cost;
    status += `\nSTRIKE (R)     ${bar(1 - sLeft / cfg.strike.cooldown)} ${sLeft ? Math.ceil(sLeft) + 's' : canPay ? 'READY' : 'need ' + cfg.strike.cost + ' pts'}`;
  }
  if ($('status').textContent !== status) $('status').textContent = status;
  $('banner').textContent = round.phase === 'intermission' ? (round.reason || 'Round over') : '';
}
requestAnimationFrame(draw);

// Optional: /?name=Sam skips the join form (handy for testing).
const qsName = new URLSearchParams(location.search).get('name');
if (qsName) { $('name').value = qsName; $('joinForm').requestSubmit(); }
