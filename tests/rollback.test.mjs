// node tests/rollback.test.mjs
// Two Rollback sessions play a small chaotic game against each other over a simulated network (latency,
// jitter, loss, reordering, spikes), on a virtual clock. Whatever the network does, both must end up with
// exactly the same game, notice no desync, and rarely have to wait.
import assert from "node:assert/strict";
import { Rollback, DT_MS } from "../badminton/rollback.js";

// ---- a small deterministic game: two movers and a bouncing ball (floats, so a wrong replay shows quickly)
const newGame = () => ({ p: [{ x: 50, vx: 0, y: 0, vy: 0 }, { x: 250, vx: 0, y: 0, vy: 0 }], b: { x: 150, y: 50, vx: 90, vy: 0 }, score: [0, 0], t: 0 });
const clone = (g) => JSON.parse(JSON.stringify(g));
function stepGame(g, inputs) {
  const dt = 1 / 60;
  g.t++;
  g.p.forEach((p, i) => {
    const v = inputs[i];
    p.vx = ((v & 2 ? 1 : 0) - (v & 1 ? 1 : 0)) * 120;
    if (v & (4 << 8) && p.y === 0) p.vy = 300; // a press of "up": jump
    p.vy -= 900 * dt;
    p.x = Math.min(300, Math.max(0, p.x + p.vx * dt));
    p.y = Math.max(0, p.y + p.vy * dt);
    if (p.y === 0) p.vy = 0;
    // a swing (press) near the ball sends it off, depending on exactly where it is
    if (v & (16 << 8) && Math.abs(g.b.x - p.x) < 20 && g.b.y < p.y + 30) {
      g.b.vx = (g.b.x - p.x) * 7 + (i ? -150 : 150);
      g.b.vy = 250 + (g.b.y - p.y) * 3;
    }
  });
  const b = g.b, sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  b.vx -= 0.002 * sp * b.vx * dt;
  b.vy -= (400 + 0.002 * sp * b.vy) * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  if (b.x < 0 || b.x > 300) (b.vx = -b.vx * 0.9), (b.x = Math.min(300, Math.max(0, b.x)));
  if (b.y < 0) {
    g.score[b.x < 150 ? 1 : 0]++;
    Object.assign(b, { x: 150, y: 80, vx: g.t % 2 ? 90 : -90, vy: 0 });
  }
}
function hashGame(g) {
  const f = new Float64Array(1), u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  JSON.stringify(g).replace(/-?\d+(\.\d+)?(e[-+]?\d+)?/g, (m) => {
    f[0] = Number(m);
    for (const w of u) h = Math.imul(h ^ w, 0x01000193);
    return m;
  });
  return h >>> 0;
}

// ---- a virtual network and clock
function run({ seconds = 30, lag = 0, jitter = 0, loss = 0, spikes = 0, startGap = 0, hz = [60, 60], corrupt = [], delay, frozen = null, bursts = null, seed = 7 } = {}) {
  let now = 0, resyncAt = -1e9;
  const corruptAt = new Set(corrupt);
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const queue = []; // { at, to, buf } or { at, to, ctl }
  const send = (to, item) => {
    if (item.buf && rnd() < loss) return;
    let d = lag + rnd() * jitter;
    if (spikes && rnd() < spikes) d += 100 + rnd() * 150; // one packet held up
    // the whole link held up for a moment, now and then (Wi-Fi scanning or power saving): [every ms, for ms]
    if (bursts && now % bursts[0] < bursts[1]) d += bursts[1] - (now % bursts[0]);
    queue.push({ at: now + (item.ctl ? lag : d), to, ...item });
  };
  const peers = [0, 1].map((me) => {
    const g = newGame(), keys = { held: 0, pressed: 0, until: 0 };
    const peer = {
      g, keys, started: me === 1 ? startGap : 0, nextTick: me === 1 ? startGap : 0,
      rb: new Rollback({
        me, now: () => now, delay,
        readInput: () => {
          const v = keys.held | (keys.pressed << 8);
          keys.pressed = 0;
          return v;
        },
        step: (a, b, frame) => {
          stepGame(g, [a, b]);
          // a desync: the guest gets these frames wrong, every time it plays them (like a math difference)
          if (me === 1 && corruptAt.has(frame)) g.score[0] += 1;
        },
        save: () => clone(g),
        load: (s) => Object.assign(g, clone(s)),
        hash: hashGame,
        send: (buf) => send(1 - me, { buf }),
        onDesync: () => {
          if (me !== 0 || now - resyncAt < 1000) return; // as game.js: the host resyncs at most once a second
          resyncAt = now;
          const fin = peer.rb.finalState();
          send(1, { ctl: { f: fin.f, s: clone(fin.s), gen: peer.rb.bumpGen() } });
        },
      }),
    };
    return peer;
  });
  const end = seconds * 1000;
  let maxGap = 0, gapSum = 0, gapN = 0;
  for (; now < end + 3000; now += 0.5) {
    queue.sort((a, b) => a.at - b.at);
    const asleep = (i) => frozen && i === 1 && now >= frozen[0] && now < frozen[1]; // a hidden tab: nothing runs
    while (queue.length && queue[0].at <= now) {
      if (asleep(queue[0].to)) break; // (its packets wait for it)
      const m = queue.shift(), rb = peers[m.to].rb;
      if (m.buf) rb.receive(m.buf);
      else rb.resync(m.ctl.f, m.ctl.s, m.ctl.gen);
    }
    peers.forEach((p, i) => {
      if (now < p.nextTick || asleep(i)) return;
      p.nextTick = now + 1000 / hz[i] + (rnd() - 0.5) * 3; // animation frames, a little uneven
      // a player: change keys now and then (until the end, then let go so everything settles)
      if (now < end && now >= p.keys.until) {
        p.keys.held = (rnd() * 4) | 0;
        if (rnd() < 0.5) p.keys.pressed |= rnd() < 0.5 ? 4 : 16;
        p.keys.until = now + 30 + rnd() * 250;
      } else if (now >= end) p.keys.held = 0;
      p.rb.tick(now);
    });
    if (now > 5000 && now < end && !(frozen && now > frozen[0] - 500 && now < frozen[1] + 3000)) {
      const gap = peers[0].rb.frame + peers[0].rb.acc / DT_MS - peers[1].rb.frame - peers[1].rb.acc / DT_MS;
      maxGap = Math.max(maxGap, Math.abs(Math.round(gap)));
      gapSum += gap;
      gapN++;
    }
  }
  // the last frame both have final, and their state there
  const [A, B] = peers.map((p) => p.rb);
  const fin = Math.min(A.remoteHave + 1, A.frame - 1, B.remoteHave + 1, B.frame - 1);
  const sa = A.states[fin % 128], sb = B.states[fin % 128];
  assert.equal(sa.f, fin);
  assert.equal(sb.f, fin);
  return { A, B, same: hashGame(sa.s) === hashGame(sb.s), fin, maxGap, meanGap: gapSum / gapN, scores: sa.s.score };
}

const cases = [
  { name: "same machine", opts: {} },
  { name: "LAN Wi-Fi (3 ms ± 4, 1% loss)", opts: { lag: 3, jitter: 4, loss: 0.01 } },
  { name: "LAN Wi-Fi with 150-250 ms hiccups", opts: { lag: 3, jitter: 6, loss: 0.02, spikes: 0.01 } },
  { name: "internet via STUN (25 ms ± 15, 2% loss)", opts: { lag: 25, jitter: 15, loss: 0.02 } },
  { name: "bad internet (60 ms ± 40, 10% loss, hiccups)", opts: { lag: 60, jitter: 40, loss: 0.1, spikes: 0.01 } },
  { name: "guest joins 300 ms late, 120 Hz screen", opts: { lag: 5, jitter: 5, startGap: 300, hz: [60, 120] } },
  { name: "fixed delay 0 on LAN", opts: { lag: 3, jitter: 4, delay: 0 } },
  { name: "guest's tab stops for 2 s, then comes back", opts: { lag: 3, jitter: 4, frozen: [10000, 12000] } },
  { name: "LAN Wi-Fi stalling 150 ms every 3 s", opts: { lag: 3, jitter: 4, loss: 0.01, bursts: [3000, 150] } },
  { name: "LAN Wi-Fi stalling 250 ms every 2 s", opts: { lag: 3, jitter: 4, loss: 0.01, bursts: [2000, 250] } },
];
for (const { name, opts } of cases) {
  const r = run(opts);
  const s = (rb) => `${rb.stats.frames} frames, ${rb.stats.replays} replays (max ${rb.stats.maxReplay}), ${rb.stats.waits} waits, delay ${rb.delay}, rtt ${Math.round(rb.rtt)}ms`;
  console.log(`${r.same ? "ok  " : "FAIL"} ${name}: final frame ${r.fin}, score ${r.scores}, frame gap ≤ ${r.maxGap} (host ahead by ${r.meanGap.toFixed(2)} on average)\n       host  ${s(r.A)}\n       guest ${s(r.B)}`);
  assert.ok(r.same, `${name}: the two games differ`);
  assert.equal(r.A.stats.desyncs + r.B.stats.desyncs, 0, `${name}: desync reported`);
  assert.ok(r.A.stats.frames > (opts.frozen ? 23 : 25) * 60, `${name}: host only played ${r.A.stats.frames} frames`);
  assert.ok(r.maxGap <= 3, `${name}: the two sides drifted ${r.maxGap} frames apart`);
  assert.ok(Math.abs(r.meanGap) < 0.75, `${name}: one side runs ${r.meanGap.toFixed(2)} frames ahead`);
  if (!opts.frozen && !opts.bursts && (!opts.loss || opts.loss < 0.05)) assert.ok(r.A.stats.waits + r.B.stats.waits <= 3 + (opts.spikes ? 60 : 0), `${name}: waited ${r.A.stats.waits + r.B.stats.waits} times`);
}

// a desync (the guest scores a point the host does not) is caught by the check and put right by the host's state
{
  const r = run({ lag: 5, jitter: 5, corrupt: [600] });
  console.log(`${r.same ? "ok  " : "FAIL"} desync at frame 600: found ${r.A.stats.desyncs + r.B.stats.desyncs}, resyncs ${r.B.stats.resyncs}, then same at frame ${r.fin}`);
  assert.ok(r.A.stats.desyncs >= 1, "the host did not notice the desync");
  assert.ok(r.B.stats.resyncs >= 1, "the guest was not resynced");
  assert.ok(r.same, "still different after the resync");
}
// every resync must stick, however the packets race the resync message: one desync found and one resync per
// corruption, never a second for the same one (the host must send a state no pending replay will change, and
// the guest must not replay back into its own state from before the host's)
for (const [net, opts] of [["50 ms ± 30", { lag: 50, jitter: 30 }], ["20 ms ± 120, 20% loss", { lag: 20, jitter: 120, loss: 0.2 }]]) {
  const corrupt = [600, 1200, 1800, 2400, 3000];
  let found = 0, resyncs = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const r = run({ ...opts, seconds: 60, corrupt, seed });
    assert.ok(r.same, `${net}, seed ${seed}: different after the resyncs`);
    assert.equal(r.A.stats.desyncs, corrupt.length, `${net}, seed ${seed}: ${r.A.stats.desyncs} desyncs for ${corrupt.length} corruptions (a resync did not stick)`);
    found += r.A.stats.desyncs;
    resyncs += r.B.stats.resyncs;
  }
  console.log(`ok   repeated desyncs over ${net}: ${found} found, ${resyncs} resyncs for ${8 * corrupt.length} corruptions, every one stuck`);
}
console.log("all rollback tests passed");
