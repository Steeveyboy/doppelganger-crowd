// Doppelganger Crowd — authoritative game server
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server);

// ---------- Tunables ----------
const W = 1200, H = 800;
const TICK_HZ = 20, DT = 1 / TICK_HZ;
const NPC_COUNT = 40;
const MAX_SPEED = 80;          // px/s, identical for everyone
const ACCEL = 240;             // px/s^2, identical for everyone
const RADIUS = 11;
const TAG_RANGE = 110;         // how close you must be to tag someone
const WRONG_TAG_COOLDOWN = 6;  // seconds
const ROUND_SECONDS = 180;
const INTERMISSION_SECONDS = 10;
const TASK_DWELL = 1.2;        // seconds standing at a station
const TASKS_PER_SET = 3;

const STATIONS = [
  { name: 'Coffee',    x: 150,  y: 130, color: '#a0522d' },
  { name: 'Fountain',  x: 600,  y: 400, color: '#3b82f6' },
  { name: 'Kiosk',     x: 1050, y: 130, color: '#f59e0b' },
  { name: 'Bench',     x: 150,  y: 670, color: '#22c55e' },
  { name: 'Gate',      x: 1050, y: 670, color: '#a855f7' },
  { name: 'Statue',    x: 600,  y: 110, color: '#94a3b8' },
  { name: 'Food Cart', x: 600,  y: 690, color: '#ef4444' },
];
const STATION_R = 38;

// ---------- State ----------
let entities = [];               // all bodies in the crowd (NPCs + players), no player flag sent to clients
const players = new Map();       // socket.id -> player record
let phase = 'playing';           // 'playing' | 'intermission'
let phaseEndsAt = 0;
let events = [];                 // transient public events (e.g. successful tags)

const rid = () => crypto.randomBytes(4).toString('hex');
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => Date.now() / 1000;

function makeEntity() {
  return {
    id: rid(), x: rand(40, W - 40), y: rand(40, H - 40), vx: 0, vy: 0,
    owner: null,                         // socket id when controlled by a player
    // NPC brain
    tx: 0, ty: 0, speedFactor: 1, wait: rand(0, 3),
  };
}

function pickNpcGoal(e) {
  if (Math.random() < 0.55) {
    const s = STATIONS[Math.floor(Math.random() * STATIONS.length)];
    e.tx = s.x + rand(-STATION_R * 0.6, STATION_R * 0.6);
    e.ty = s.y + rand(-STATION_R * 0.6, STATION_R * 0.6);
  } else {
    e.tx = rand(40, W - 40);
    e.ty = rand(40, H - 40);
  }
  e.speedFactor = rand(0.55, 1.0);
}

function newTasks() {
  const pool = [...STATIONS.keys()].sort(() => Math.random() - 0.5);
  return pool.slice(0, TASKS_PER_SET);
}

function freeNpc() {
  const free = entities.filter(e => !e.owner);
  return free[Math.floor(Math.random() * free.length)];
}

function attachPlayer(p) {
  const e = freeNpc() || (entities.push(makeEntity()), entities[entities.length - 1]);
  e.owner = p.sid;
  p.entityId = e.id;
  p.alive = true;
  p.tasks = newTasks();
  p.dwell = 0;
  p.cooldownUntil = 0;
  p.input = { dx: 0, dy: 0, slow: false, mx: null, my: null };
}

function startRound() {
  entities = [];
  for (let i = 0; i < NPC_COUNT + players.size; i++) {
    const e = makeEntity(); pickNpcGoal(e); entities.push(e);
  }
  for (const p of players.values()) attachPlayer(p);
  phase = 'playing';
  phaseEndsAt = now() + ROUND_SECONDS;
  events = [];
  io.emit('round', { phase, endsAt: phaseEndsAt });
  for (const p of players.values()) sendPrivate(p);
}

function endRound(reason) {
  phase = 'intermission';
  phaseEndsAt = now() + INTERMISSION_SECONDS;
  // Reveal who was who
  const reveal = [...players.values()].filter(p => p.alive).map(p => ({ id: p.entityId, name: p.name }));
  io.emit('round', { phase, endsAt: phaseEndsAt, reason, reveal });
}

function sendPrivate(p) {
  io.to(p.sid).emit('you', {
    entityId: p.alive ? p.entityId : null,
    alive: p.alive,
    tasks: p.tasks.map(i => STATIONS[i].name),
    cooldownUntil: p.cooldownUntil,
  });
}

function scoreboard() {
  return [...players.values()]
    .map(p => ({ name: p.name, score: p.score, alive: p.alive }))
    .sort((a, b) => b.score - a.score);
}

// ---------- Simulation ----------
function steer(e, dvx, dvy) {
  // Accelerate current velocity toward desired velocity with a capped acceleration (same for all bodies).
  let ax = dvx - e.vx, ay = dvy - e.vy;
  const am = Math.hypot(ax, ay), maxDv = ACCEL * DT;
  if (am > maxDv) { ax *= maxDv / am; ay *= maxDv / am; }
  e.vx += ax; e.vy += ay;
}

function tick() {
  const t = now();
  if (t >= phaseEndsAt) {
    if (phase === 'playing') endRound('Time up!');
    else startRound();
  }

  const byId = new Map(entities.map(e => [e.id, e]));

  for (const e of entities) {
    let dvx = 0, dvy = 0;
    const p = e.owner && players.get(e.owner);
    if (p && phase === 'playing') {
      const inp = p.input;
      let dx = inp.dx, dy = inp.dy;
      if (!dx && !dy && inp.mx != null) {           // click-to-walk target
        dx = inp.mx - e.x; dy = inp.my - e.y;
        if (Math.hypot(dx, dy) < 6) { dx = dy = 0; inp.mx = inp.my = null; }
      }
      const m = Math.hypot(dx, dy);
      if (m > 0) {
        const sp = MAX_SPEED * (inp.slow ? 0.6 : 1);
        dvx = dx / m * sp; dvy = dy / m * sp;
      }
    } else if (!e.owner) {
      if (e.wait > 0) { e.wait -= DT; }
      else {
        const dx = e.tx - e.x, dy = e.ty - e.y, d = Math.hypot(dx, dy);
        if (d < 8) { e.wait = Math.random() < 0.6 ? rand(0.8, 4) : 0; pickNpcGoal(e); }
        else {
          const sp = MAX_SPEED * e.speedFactor * Math.min(1, d / 40);
          // slight wobble so paths aren't laser-straight
          const wob = Math.sin(t * 1.3 + e.x * 0.01) * 0.25;
          const c = Math.cos(wob), s = Math.sin(wob);
          const ux = dx / d, uy = dy / d;
          dvx = (ux * c - uy * s) * sp; dvy = (ux * s + uy * c) * sp;
        }
      }
    }
    steer(e, dvx, dvy);
  }

  // Soft separation so the crowd doesn't stack
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i], b = entities[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < RADIUS * 2.2) {
        const push = (RADIUS * 2.2 - d) * 0.5, ux = dx / d, uy = dy / d;
        a.x -= ux * push * 0.5; a.y -= uy * push * 0.5;
        b.x += ux * push * 0.5; b.y += uy * push * 0.5;
      }
    }
  }

  for (const e of entities) {
    e.x = clamp(e.x + e.vx * DT, RADIUS, W - RADIUS);
    e.y = clamp(e.y + e.vy * DT, RADIUS, H - RADIUS);
  }

  // Tasks
  if (phase === 'playing') {
    for (const p of players.values()) {
      if (!p.alive) continue;
      const e = byId.get(p.entityId); if (!e) continue;
      const st = STATIONS[p.tasks[0]];
      if (Math.hypot(e.x - st.x, e.y - st.y) < STATION_R) {
        p.dwell += DT;
        if (p.dwell >= TASK_DWELL) {
          p.dwell = 0; p.score += 1; p.tasks.shift();
          if (!p.tasks.length) { p.tasks = newTasks(); p.score += 2; }
          sendPrivate(p);
        }
      } else p.dwell = Math.max(0, p.dwell - DT * 2);
    }
  }

  // Shuffle order every tick so array position leaks nothing.
  const snap = entities
    .map(e => [e.id, Math.round(e.x), Math.round(e.y)])
    .sort(() => Math.random() - 0.5);
  io.emit('s', { t: Date.now(), e: snap, ev: events, sb: scoreboard() });
  events = [];
}

// ---------- Networking ----------
io.on('connection', socket => {
  socket.on('join', name => {
    if (players.has(socket.id)) return;
    name = String(name || 'Anon').replace(/[^\w \-]/g, '').slice(0, 16) || 'Anon';
    const p = { sid: socket.id, name, score: 0, alive: false, tasks: [], input: {} };
    players.set(socket.id, p);
    if (phase === 'playing') attachPlayer(p);
    socket.emit('init', { W, H, stations: STATIONS, stationR: STATION_R, radius: RADIUS, tagRange: TAG_RANGE });
    socket.emit('round', { phase, endsAt: phaseEndsAt });
    sendPrivate(p);
  });

  socket.on('input', inp => {
    const p = players.get(socket.id); if (!p || !inp) return;
    const dx = clamp(Number(inp.dx) || 0, -1, 1), dy = clamp(Number(inp.dy) || 0, -1, 1);
    p.input.dx = dx; p.input.dy = dy; p.input.slow = !!inp.slow;
    if (dx || dy) { p.input.mx = p.input.my = null; }
  });

  socket.on('moveTo', m => {
    const p = players.get(socket.id); if (!p || !m) return;
    p.input.mx = clamp(Number(m.x) || 0, 0, W); p.input.my = clamp(Number(m.y) || 0, 0, H);
  });

  socket.on('tag', targetId => {
    const p = players.get(socket.id);
    if (!p || !p.alive || phase !== 'playing') return;
    const t = now();
    if (t < p.cooldownUntil) return;
    const me = entities.find(e => e.id === p.entityId);
    const target = entities.find(e => e.id === targetId);
    if (!me || !target || target === me) return;
    if (Math.hypot(me.x - target.x, me.y - target.y) > TAG_RANGE) {
      socket.emit('msg', 'Too far away to tag!'); return;
    }
    const victim = target.owner && players.get(target.owner);
    if (victim && victim.alive) {
      p.score += 5;
      victim.alive = false;
      entities = entities.filter(e => e !== target);
      events.push({ type: 'caught', x: target.x, y: target.y, name: victim.name });
      io.emit('msg', `${p.name} unmasked ${victim.name}!`);
      sendPrivate(victim);
      io.to(victim.sid).emit('msg', `You were unmasked by ${p.name}. Spectating until next round.`);
      const alive = [...players.values()].filter(q => q.alive);
      if (players.size > 1 && alive.length <= 1) {
        if (alive[0]) alive[0].score += 3;
        endRound(alive[0] ? `${alive[0].name} is the last human standing!` : 'Everyone was unmasked!');
      }
    } else {
      p.score -= 1;
      p.cooldownUntil = t + WRONG_TAG_COOLDOWN;
      socket.emit('msg', `Just a doppel. -1 point, tagging locked for ${WRONG_TAG_COOLDOWN}s.`);
    }
    sendPrivate(p);
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id); if (!p) return;
    players.delete(socket.id);
    const e = entities.find(e => e.owner === socket.id);
    if (e) { e.owner = null; pickNpcGoal(e); }   // body silently reverts to a doppel
  });
});

startRound();
setInterval(tick, 1000 / TICK_HZ);
server.listen(PORT, () => console.log(`Doppelganger Crowd on http://localhost:${PORT}`));
