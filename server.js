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
const W = 1000, H = 1000;   // square world, drawn as an isometric diamond
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

// Dash (Shift): short burst of speed. NPCs never dash, but they do occasionally hurry,
// so a quick figure is suspicious rather than proof.
const DASH_SPEED = 1.9;        // x MAX_SPEED
const DASH_SECONDS = 0.9;
const DASH_COOLDOWN = 8;
const NPC_HURRY_CHANCE = 0.08; // chance an NPC hurries (1.35x) on a given walk

// Airstrike (R): pay points, mark a spot anywhere; it lands after a warning everyone can see.
const STRIKE_COST = 3;         // points spent up front (need at least this many)
const STRIKE_COOLDOWN = 40;    // seconds between your strikes
const STRIKE_DELAY = 2.5;      // warning time before impact
const STRIKE_RADIUS = 75;
const STRIKE_HUMAN_REWARD = 5; // per human caught
const STRIKE_NPC_PENALTY = 1;  // per doppel caught (doppels are removed, then wander back in)
const NPC_RESPAWN_SECONDS = 6;

const STATIONS = [
  { name: 'Coffee',    x: 180, y: 180, color: '#d19a66' },
  { name: 'Fountain',  x: 500, y: 500, color: '#61afef' },
  { name: 'Kiosk',     x: 820, y: 180, color: '#e5c07b' },
  { name: 'Bench',     x: 180, y: 820, color: '#98c379' },
  { name: 'Gate',      x: 820, y: 820, color: '#c678dd' },
  { name: 'Statue',    x: 500, y: 140, color: '#abb2bf' },
  { name: 'Food Cart', x: 500, y: 860, color: '#e06c75' },
];
const STATION_R = 38;

// ---------- State ----------
let entities = [];               // all bodies in the crowd (NPCs + players), no player flag sent to clients
const players = new Map();       // socket.id -> player record
let phase = 'playing';           // 'playing' | 'intermission'
let phaseEndsAt = 0;
let events = [];                 // transient public events (e.g. successful tags)
let strikes = [];                // pending airstrikes {x, y, at, owner}
let respawns = [];               // times at which a destroyed doppel walks back in

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
  e.speedFactor = Math.random() < NPC_HURRY_CHANCE ? 1.35 : rand(0.55, 1.0);
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
  p.dashUntil = 0; p.dashReadyAt = 0;
  p.strikeReadyAt = 0;
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
  events = []; strikes = []; respawns = [];
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
    dashUntil: p.dashUntil, dashReadyAt: p.dashReadyAt,
    strikeReadyAt: p.strikeReadyAt, score: p.score,
  });
}

function scoreboard() {
  return [...players.values()]
    .map(p => ({ name: p.name, score: p.score, alive: p.alive }))
    .sort((a, b) => b.score - a.score);
}

// ---------- Simulation ----------
function steer(e, dvx, dvy, accel = ACCEL) {
  // Accelerate current velocity toward desired velocity with a capped acceleration (same for all bodies).
  let ax = dvx - e.vx, ay = dvy - e.vy;
  const am = Math.hypot(ax, ay), maxDv = accel * DT;
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
      const dashing = t < p.dashUntil;
      if (m > 0) {
        const sp = MAX_SPEED * (dashing ? DASH_SPEED : inp.slow ? 0.6 : 1);
        dvx = dx / m * sp; dvy = dy / m * sp;
      }
      if (dashing) { steer(e, dvx, dvy, ACCEL * 3); continue; }
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

  // Airstrikes + doppel respawns
  for (const st of strikes.filter(st => t >= st.at)) detonate(st);
  strikes = strikes.filter(st => t < st.at);
  while (respawns.length && respawns[0] <= t) {
    respawns.shift();
    const e = makeEntity();                       // walks in from a random edge
    if (Math.random() < 0.5) e.x = Math.random() < 0.5 ? RADIUS : W - RADIUS;
    else e.y = Math.random() < 0.5 ? RADIUS : H - RADIUS;
    pickNpcGoal(e); e.wait = 0; entities.push(e);
  }

  // Shuffle order every tick so array position leaks nothing.
  const snap = entities
    .map(e => [e.id, Math.round(e.x), Math.round(e.y)])
    .sort(() => Math.random() - 0.5);
  const pend = strikes.map(st => [Math.round(st.x), Math.round(st.y), +(st.at - t).toFixed(2)]);
  io.emit('s', { t: Date.now(), e: snap, ev: events, sb: scoreboard(), st: pend });
  events = [];
}

function eliminate(victim, killer, how) {
  const body = entities.find(e => e.id === victim.entityId);
  victim.alive = false;
  if (body) {
    entities = entities.filter(e => e !== body);
    events.push({ type: 'caught', x: body.x, y: body.y, name: victim.name });
  }
  io.emit('msg', killer === victim ? `${victim.name} was caught in their own airstrike!`
    : `${killer.name} unmasked ${victim.name}${how === 'strike' ? ' with an airstrike' : ''}!`);
  sendPrivate(victim);
  io.to(victim.sid).emit('msg', killer === victim ? 'You airstruck yourself. Spectating until next round.'
    : `You were unmasked by ${killer.name}. Spectating until next round.`);
}

function checkLastStanding() {
  if (phase !== 'playing') return;
  const alive = [...players.values()].filter(q => q.alive);
  if (players.size > 1 && alive.length <= 1) {
    if (alive[0]) alive[0].score += 3;
    endRound(alive[0] ? `${alive[0].name} is the last human standing!` : 'Everyone was unmasked!');
  }
}

function detonate(st) {
  if (phase !== 'playing') return;
  const owner = players.get(st.owner);          // may have left; strike still lands
  const hit = entities.filter(e => Math.hypot(e.x - st.x, e.y - st.y) <= STRIKE_RADIUS);
  let humans = 0, doppels = 0;
  for (const e of hit) {
    const victim = e.owner && players.get(e.owner);
    if (victim && victim.alive) {
      if (owner && victim !== owner) { owner.score += STRIKE_HUMAN_REWARD; humans++; }
      eliminate(victim, owner || victim, 'strike');
    } else if (!e.owner) {
      entities = entities.filter(x => x !== e);
      respawns.push(now() + NPC_RESPAWN_SECONDS);
      doppels++;
    }
  }
  if (owner) owner.score -= doppels * STRIKE_NPC_PENALTY;
  events.push({ type: 'boom', x: st.x, y: st.y, r: STRIKE_RADIUS });
  if (owner) {
    io.to(owner.sid).emit('msg', `Airstrike: ${humans} human${humans === 1 ? '' : 's'} (+${humans * STRIKE_HUMAN_REWARD}), ` +
      `${doppels} doppel${doppels === 1 ? '' : 's'} (-${doppels * STRIKE_NPC_PENALTY}).`);
    sendPrivate(owner);
  }
  checkLastStanding();
}

// ---------- Networking ----------
io.on('connection', socket => {
  socket.on('join', name => {
    if (players.has(socket.id)) return;
    name = String(name || 'Anon').replace(/[^\w \-]/g, '').slice(0, 16) || 'Anon';
    const p = { sid: socket.id, name, score: 0, alive: false, tasks: [], input: {} };
    players.set(socket.id, p);
    if (phase === 'playing') attachPlayer(p);
    socket.emit('init', { W, H, stations: STATIONS, stationR: STATION_R, radius: RADIUS, tagRange: TAG_RANGE,
      strike: { cost: STRIKE_COST, cooldown: STRIKE_COOLDOWN, radius: STRIKE_RADIUS, delay: STRIKE_DELAY },
      dash: { seconds: DASH_SECONDS, cooldown: DASH_COOLDOWN } });
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
      eliminate(victim, p, 'tag');
      checkLastStanding();
    } else {
      p.score -= 1;
      p.cooldownUntil = t + WRONG_TAG_COOLDOWN;
      socket.emit('msg', `Just a doppel. -1 point, tagging locked for ${WRONG_TAG_COOLDOWN}s.`);
    }
    sendPrivate(p);
  });

  socket.on('dash', () => {
    const p = players.get(socket.id);
    if (!p || !p.alive || phase !== 'playing') return;
    const t = now();
    if (t < p.dashReadyAt) return;
    p.dashUntil = t + DASH_SECONDS;
    p.dashReadyAt = t + DASH_COOLDOWN;
    sendPrivate(p);
  });

  socket.on('strike', m => {
    const p = players.get(socket.id);
    if (!p || !p.alive || phase !== 'playing' || !m) return;
    const t = now();
    if (t < p.strikeReadyAt) return socket.emit('msg', 'Airstrike still on cooldown.');
    if (p.score < STRIKE_COST) return socket.emit('msg', `An airstrike costs ${STRIKE_COST} points. Do some tasks first.`);
    p.score -= STRIKE_COST;
    p.strikeReadyAt = t + STRIKE_COOLDOWN;
    strikes.push({ x: clamp(Number(m.x) || 0, 0, W), y: clamp(Number(m.y) || 0, 0, H), at: t + STRIKE_DELAY, owner: p.sid });
    io.emit('msg', 'INCOMING AIRSTRIKE!');
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
