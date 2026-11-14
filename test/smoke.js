// Smoke test: two bots join, one walks to the other and tags it.
// Usage: start the server (PORT=3999 node server.js), then: node test/smoke.js
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3999';
const fail = m => { console.error('FAIL:', m); process.exit(1); };

const a = io(URL), b = io(URL);
const st = { a: {}, b: {} };
let last = null;
let msgs = [];
for (const [k, s] of [['a', a], ['b', b]]) {
  s.on('you', y => (st[k] = y));
  s.on('msg', m => msgs.push(`${k}: ${m}`));
}
a.on('s', s => {
  last = s;
  if (s.e.some(e => e.length !== 3)) fail('snapshot leaks extra fields');
});
a.emit('join', 'Alice'); b.emit('join', 'Bob');

setTimeout(() => {
  if (!last) fail('no snapshots');
  console.log('entities:', last.e.length, 'players:', last.sb.length);
  if (!st.a.entityId || !st.b.entityId) fail('players not attached');
  if (st.a.tasks.length !== 3) fail('no tasks');
  // wrong tag first (pick an entity that is neither)
  const pos = id => last.e.find(e => e[0] === id);
  const bob = pos(st.b.entityId);
  a.emit('moveTo', { x: bob[1], y: bob[2] });
  const chase = setInterval(() => {
    const bp = pos(st.b.entityId); if (bp) a.emit('moveTo', { x: bp[1], y: bp[2] });
  }, 200);
  const tryTag = setInterval(() => {
    const ap = pos(st.a.entityId), bp = pos(st.b.entityId);
    if (ap && bp && Math.hypot(ap[1] - bp[1], ap[2] - bp[2]) < 100) {
      clearInterval(tryTag); clearInterval(chase);
      a.emit('tag', st.b.entityId);
      setTimeout(() => {
        console.log(msgs.join('\n'));
        const alice = last.sb.find(p => p.name === 'Alice');
        if (st.b.alive) fail('Bob still alive');
        if (alice.score < 5) fail('Alice not scored');
        if (!msgs.some(m => m.includes('last human'))) console.log('(no round end msg, ok)');
        console.log('PASS'); process.exit(0);
      }, 500);
    }
  }, 100);
  setTimeout(() => fail('timed out chasing'), 25000);
}, 800);
