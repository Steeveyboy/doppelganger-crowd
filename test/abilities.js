// Tests dash + airstrike. Three bots: Alice tags Bob (+5), dashes, then airstrikes Carol.
// Usage: PORT=3999 node server.js  &&  node test/abilities.js
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3999';
const fail = m => { console.error('FAIL:', m); process.exit(1); };
const wait = ms => new Promise(r => setTimeout(r, ms));

const bots = {}, st = {}, msgs = [];
let last = null;
for (const n of ['Alice', 'Bob', 'Carol']) {
  const s = io(URL); bots[n] = s; st[n] = {};
  s.on('you', y => (st[n] = y));
  s.on('msg', m => msgs.push(`${n}: ${m}`));
  s.emit('join', n);
}
bots.Alice.on('s', s => (last = s));
const pos = id => { const e = last.e.find(e => e[0] === id); return e && { x: e[1], y: e[2] }; };
const score = n => last.sb.find(p => p.name === n).score;

(async () => {
  await wait(800);
  if (!st.Alice.entityId) fail('Alice not attached');

  // 1. Dash: measure speed while dashing vs walking
  bots.Alice.emit('input', { dx: 1, dy: 0 });
  await wait(1200);
  let a = pos(st.Alice.entityId); await wait(500); let b = pos(st.Alice.entityId);
  const walk = Math.hypot(b.x - a.x, b.y - a.y) / 0.5;
  bots.Alice.emit('input', { dx: -1, dy: 0 });
  await wait(1200);
  bots.Alice.emit('dash');
  await wait(250);
  a = pos(st.Alice.entityId); await wait(400); b = pos(st.Alice.entityId);
  const dash = Math.hypot(b.x - a.x, b.y - a.y) / 0.4;
  console.log(`walk ${walk.toFixed(0)} px/s, dash ${dash.toFixed(0)} px/s`);
  if (dash < walk * 1.5) fail('dash not faster');
  if (!(st.Alice.dashReadyAt > Date.now() / 1000)) fail('dash cooldown not set');
  bots.Alice.emit('input', { dx: 0, dy: 0 });

  // 2. Strike without enough points is refused
  bots.Alice.emit('strike', { x: 500, y: 500 });
  await wait(200);
  if (!msgs.some(m => m.includes('costs 3 points'))) fail('strike not refused at 0 points');

  // 3. Earn points: chase and tag Bob
  for (let i = 0; i < 200; i++) {
    const me = pos(st.Alice.entityId), bob = pos(st.Bob.entityId);
    if (Math.hypot(me.x - bob.x, me.y - bob.y) < 90) { bots.Alice.emit('tag', st.Bob.entityId); break; }
    bots.Alice.emit('moveTo', bob); await wait(150);
  }
  await wait(300);
  if (st.Bob.alive) fail('Bob not tagged');
  const before = score('Alice');
  console.log('Alice score after tag:', before);

  // 4. Airstrike Carol (standing still); Alice keeps away
  const carol = pos(st.Carol.entityId);
  const me = pos(st.Alice.entityId);
  if (Math.hypot(me.x - carol.x, me.y - carol.y) < 120) fail('Alice too close to Carol for clean test (rerun)');
  bots.Alice.emit('strike', carol);
  await wait(300);
  if (!last.st || last.st.length !== 1) fail('pending strike not broadcast');
  console.log('pending strike:', JSON.stringify(last.st));
  await wait(2800);
  if (st.Carol.alive) fail('Carol survived the strike');
  console.log(msgs.filter(m => m.startsWith('Alice')).join('\n'));
  console.log('Alice final score:', score('Alice'));
  console.log('PASS'); process.exit(0);
})();
setTimeout(() => fail('timeout'), 40000);
