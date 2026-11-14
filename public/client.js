const socket = io();
const cv = document.getElementById('game'), ctx = cv.getContext('2d');
const $ = id => document.getElementById(id);

let cfg = null, me = { entityId: null, alive: false, tasks: [], cooldownUntil: 0 };
let round = { phase: 'playing', endsAt: 0, reveal: [] };
let snaps = [];             // [{recv, map: Map(id -> [x,y])}]
let effects = [];           // caught markers
let hoverId = null, mouse = { x: -1, y: -1 }, scale = 1;
let clockSkew = 0;          // serverSec - localSec
const INTERP_MS = 120;

// ---------- Join ----------
$('joinForm').onsubmit = e => {
  e.preventDefault();
  socket.emit('join', $('name').value.trim());
  $('join').style.display = 'none';
  cv.focus();
};

socket.on('init', c => { cfg = c; resize(); });
socket.on('round', r => { round = { reveal: [], ...r }; effects = []; });
socket.on('you', y => { me = y; renderHud(); });
socket.on('msg', toast);
socket.on('s', s => {
  clockSkew = s.t / 1000 - Date.now() / 1000;
  snaps.push({ recv: performance.now(), map: new Map(s.e.map(([id, x, y]) => [id, [x, y]])) });
  if (snaps.length > 10) snaps.shift();
  for (const ev of s.ev) if (ev.type === 'caught') effects.push({ ...ev, until: performance.now() + 3000 });
  $('scores').innerHTML = s.sb.map(p => `<div class="${p.alive ? '' : 'dead'}">${esc(p.name)} — ${p.score}</div>`).join('');
});

function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let toastTimer;
function toast(m) { const t = $('toast'); t.textContent = m; t.style.opacity = 1; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.opacity = 0, 2800); }

function renderHud() {
  $('tasks').innerHTML = me.tasks.map((t, i) => `<div class="task ${i === 0 ? 'next' : ''}">${i === 0 ? '▶ ' : '· '}${esc(t)}</div>`).join('');
}

// ---------- Layout ----------
function resize() {
  if (!cfg) return;
  scale = Math.min(innerWidth / cfg.W, innerHeight / cfg.H);
  cv.width = cfg.W * scale * devicePixelRatio; cv.height = cfg.H * scale * devicePixelRatio;
  cv.style.width = cfg.W * scale + 'px'; cv.style.height = cfg.H * scale + 'px';
  cv.style.marginTop = (innerHeight - cfg.H * scale) / 2 + 'px';
}
addEventListener('resize', resize);
function toWorld(ev) { const r = cv.getBoundingClientRect(); return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale }; }

// ---------- Input ----------
const keys = new Set();
let lastSent = '';
function sendInput() {
  const dx = (keys.has('d') || keys.has('arrowright')) - (keys.has('a') || keys.has('arrowleft'));
  const dy = (keys.has('s') || keys.has('arrowdown')) - (keys.has('w') || keys.has('arrowup'));
  const inp = { dx, dy, slow: keys.has('shift') };
  const k = JSON.stringify(inp);
  if (k !== lastSent) { lastSent = k; socket.emit('input', inp); }
}
addEventListener('keydown', e => {
  if ($('join').style.display !== 'none') return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); tryTag(); return; }
  if (k.startsWith('arrow')) e.preventDefault();
  keys.add(k); sendInput();
});
addEventListener('keyup', e => { keys.delete(e.key.toLowerCase()); sendInput(); });
addEventListener('blur', () => { keys.clear(); sendInput(); });
cv.addEventListener('mousemove', e => { mouse = toWorld(e); });
cv.addEventListener('mousedown', e => {
  if (e.button === 0) { const w = toWorld(e); socket.emit('moveTo', w); effects.push({ type: 'click', x: w.x, y: w.y, until: performance.now() + 400 }); }
  if (e.button === 2) tryTag();
});
cv.addEventListener('contextmenu', e => e.preventDefault());

function tryTag() {
  if (!hoverId || hoverId === me.entityId) return;
  if (Date.now() / 1000 + clockSkew < me.cooldownUntil) { toast('Tagging is locked — wait for the cooldown.'); return; }
  socket.emit('tag', hoverId);
}

// ---------- Rendering ----------
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

const lastPos = new Map(), facing = new Map();

function draw() {
  requestAnimationFrame(draw);
  if (!cfg) return;
  ctx.setTransform(scale * devicePixelRatio, 0, 0, scale * devicePixelRatio, 0, 0);
  ctx.fillStyle = '#d9d4c7'; ctx.fillRect(0, 0, cfg.W, cfg.H);

  // plaza tiles
  ctx.strokeStyle = 'rgba(0,0,0,.05)'; ctx.lineWidth = 1;
  for (let x = 0; x < cfg.W; x += 50) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cfg.H); ctx.stroke(); }
  for (let y = 0; y < cfg.H; y += 50) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cfg.W, y); ctx.stroke(); }

  const t = performance.now();
  const nextTask = me.alive && me.tasks[0];
  for (const s of cfg.stations) {
    ctx.fillStyle = s.color + '55'; ctx.beginPath(); ctx.arc(s.x, s.y, cfg.stationR, 0, 7); ctx.fill();
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.stroke();
    if (s.name === nextTask) {
      ctx.strokeStyle = '#facc15'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(s.x, s.y, cfg.stationR + 6 + Math.sin(t / 200) * 3, 0, 7); ctx.stroke();
    }
    ctx.fillStyle = '#222'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(s.name, s.x, s.y - cfg.stationR - 8);
  }

  const pos = interpolated();
  const mine = me.alive ? pos.get(me.entityId) : null;

  // tag range
  if (mine) {
    ctx.strokeStyle = 'rgba(0,0,0,.15)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(mine[0], mine[1], cfg.tagRange, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  }

  // hover target
  hoverId = null; let best = cfg.radius + 8;
  for (const [id, [x, y]] of pos) {
    const d = Math.hypot(x - mouse.x, y - mouse.y);
    if (d < best && id !== me.entityId) { best = d; hoverId = id; }
  }

  // bodies (all identical)
  const r = cfg.radius;
  for (const [id, [x, y]] of pos) {
    const lp = lastPos.get(id);
    if (lp) { const dx = x - lp[0], dy = y - lp[1]; if (Math.hypot(dx, dy) > 0.3) facing.set(id, Math.atan2(dy, dx)); }
    lastPos.set(id, [x, y]);
    const a = facing.get(id) || 0;
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(x + 2, y + 4, r, r * 0.7, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#4b5563'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.fillStyle = '#f1c9a5'; ctx.beginPath(); ctx.arc(x + Math.cos(a) * 4, y + Math.sin(a) * 4, r * 0.55, 0, 7); ctx.fill();
    if (id === me.entityId) { ctx.strokeStyle = '#facc15'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r + 4, 0, 7); ctx.stroke(); }
    if (id === hoverId) {
      const inRange = mine && Math.hypot(x - mine[0], y - mine[1]) <= cfg.tagRange;
      ctx.strokeStyle = inRange ? '#dc2626' : '#888'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 6, 0, 7); ctx.stroke();
    }
  }
  if (lastPos.size > 400) { lastPos.clear(); facing.clear(); }

  // reveal at round end
  if (round.phase === 'intermission') {
    for (const rv of round.reveal || []) {
      const p = pos.get(rv.id); if (!p) continue;
      ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p[0], p[1], r + 6, 0, 7); ctx.stroke();
      ctx.fillStyle = '#111'; ctx.font = 'bold 13px system-ui'; ctx.fillText(rv.name, p[0], p[1] - r - 10);
    }
  }

  // effects
  effects = effects.filter(e => e.until > t);
  for (const e of effects) {
    if (e.type === 'caught') {
      ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(e.x - 14, e.y - 14); ctx.lineTo(e.x + 14, e.y + 14); ctx.moveTo(e.x + 14, e.y - 14); ctx.lineTo(e.x - 14, e.y + 14); ctx.stroke();
      ctx.fillStyle = '#dc2626'; ctx.font = 'bold 13px system-ui'; ctx.fillText(e.name, e.x, e.y - 20);
    } else if (e.type === 'click') {
      ctx.strokeStyle = 'rgba(250,204,21,.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(e.x, e.y, 6 + (400 - (e.until - t)) / 40, 0, 7); ctx.stroke();
    }
  }

  // status + banner
  const left = Math.max(0, Math.ceil(round.endsAt - (Date.now() / 1000 + clockSkew)));
  const cd = Math.max(0, Math.ceil(me.cooldownUntil - (Date.now() / 1000 + clockSkew)));
  $('status').textContent = round.phase === 'playing'
    ? `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` + (cd ? `  · tag locked ${cd}s` : '') + (me.alive ? '' : '  · spectating')
    : `Next round in ${left}s`;
  $('banner').textContent = round.phase === 'intermission' ? (round.reason || 'Round over') : '';
}
requestAnimationFrame(draw);
