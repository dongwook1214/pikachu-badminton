// Rollback netcode for a two-player game that steps at a fixed 60 Hz (the GGPO approach). No DOM: game.js wires
// it to a WebRTC data channel, and tests/rollback.test.mjs drives two of them over a simulated bad network.
//
// Both browsers run the whole game, and only inputs travel between them:
//  - Every packet carries all of our inputs the other side has not confirmed yet, so a lost or late packet costs
//    nothing as long as any later one arrives. The channel never retransmits and never holds packets back.
//  - The other player's input for a frame that has not arrived yet is predicted (the keys they held last). When
//    the real one arrives and differs, the game is rewound to that frame and played forward again in one go, so
//    neither player ever waits for the network to see their own moves.
//  - Input delay: our own input is applied `delay` frames later (0 on a LAN), which gives it time to reach the
//    other side before that frame is played there, so rewinds stay rare and short.
//  - Time sync: the side running ahead of the other slows down a little until both play the same frame at the
//    same moment.
//  - Prediction is capped at maxPredict frames; beyond that the game waits for the other side instead.
//  - Desync check: once a second both sides hash the state of a frame whose inputs are all known. They must
//    match. If not, onDesync fires; game.js then has the host send its state and the guest calls resync().

export const DT_MS = 1000 / 60;
const RING = 1024; // frames of inputs kept (17 s): resends, replays, resync
const STATES = 128; // frames of saved states
const HELD = 0x7f; // input bits that are keys held down (a prediction keeps them held); the rest are one-frame presses
const PER_PACKET = 128; // most inputs in one packet
const SUM_EVERY = 60; // frames between state checks
const T_INPUT = 1;
const HEADER = 46;
const SYNC_WINDOW = 600; // ms of packets the clock comparison looks back over

export class Rollback {
  /**
   * @param {object} o
   * @param {0|1} o.me                which player this side is (0: host, 1P; 1: guest, 2P)
   * @param {() => number} o.readInput our input for the next frame (bits; the game clears its one-frame presses)
   * @param {(a: number, b: number, frame: number, replay: boolean) => void} o.step  play one frame (1P's input, 2P's)
   * @param {() => any} o.save        a copy of the game state; @param {(s: any) => void} o.load puts one back
   * @param {(s: any) => number} o.hash  a 32-bit hash of a saved state
   * @param {(buf: ArrayBuffer) => void} o.send  send one packet (unreliable, unordered is best)
   * @param {() => number} o.now      milliseconds
   * @param {(from: number, to: number) => void} [o.beforeReplay]  @param {(from: number) => void} [o.afterReplay]
   * @param {(frame: number) => void} [o.onDesync]
   * @param {number} [o.delay]        fixed input delay in frames (default: chosen from the round trip)
   * @param {number} [o.maxPredict]   frames we may run ahead of the other side's last known input
   */
  constructor(o) {
    Object.assign(this, { beforeReplay() {}, afterReplay() {}, onDesync() {}, maxPredict: 12 }, o);
    this.fixedDelay = o.delay ?? null;
    this.delay = this.fixedDelay ?? 1; // until the round trip is known
    this.frame = 0; // the next frame to play: frames before it are done
    this.inputs = [new Int32Array(RING), new Int32Array(RING)];
    this.used = new Int32Array(RING); // the other side's input each frame was played with (actual or predicted)
    this.states = new Array(STATES);
    this.localNext = 0; // the next frame our input will be written to
    this.remoteHave = -1; // all of the other side's inputs up to this frame are here
    this.lastRemote = 0; // their latest input
    this.ackMine = -1; // they have all of ours up to this frame
    this.replayFrom = Infinity;
    this.floor = 0; // after a resync: the host's state for this frame stands, nothing before it is replayed again
    this.acc = 0;
    this.last = null;
    this.rtts = []; // recent round trips (ms)
    this.rtt = null; // their median
    this.echo = -1; // their latest send time, to echo back, and when we got it
    this.echoAt = 0;
    this.offsets = []; // { at, x }: our frame when a packet came, less theirs when they sent it
    this.lead = 0; // how many frames we play ahead of them
    this.slowing = false;
    this.tickAt = null; // this.now() at our last tick
    this.delayAt = -1e9;
    this.sums = new Map(); // frame -> { mine, theirs }
    this.sumNext = SUM_EVERY;
    this.lastSum = null; // [frame, hash, gen] of our latest check, sent with every packet
    this.gen = 0; // resyncs so far: checks from before the latest one are ignored
    this.lastSend = -1e9;
    this.waitingSince = null;
    this.stats = { frames: 0, replays: 0, replayed: 0, maxReplay: 0, waits: 0, desyncs: 0, resyncs: 0, sent: 0, received: 0 };
  }

  /** Advance to `now` (call it every animation frame). Returns how many new frames were played. */
  tick(now) {
    if (this.last === null) this.last = now;
    let elapsed = Math.min(now - this.last, 250);
    this.last = now;
    this.syncTime();
    if (this.slowing) elapsed *= 0.9; // ahead of them: let them catch up
    this.acc += elapsed;
    this.tickAt = this.now();
    this.adaptDelay(now);
    this.replay();
    let n = 0;
    while (this.acc >= DT_MS) {
      if (this.frame - this.remoteHave > this.maxPredict) {
        // too far past what we know of them: wait (and don't save up time to rush through afterwards)
        if (this.waitingSince === null) (this.waitingSince = now), this.stats.waits++;
        this.acc = Math.min(this.acc, DT_MS);
        break;
      }
      this.waitingSince = null;
      this.writeLocal();
      this.play(false);
      this.acc -= DT_MS;
      n++;
    }
    this.check();
    if (n || now - this.lastSend >= 30) this.sendInputs(now);
    return n;
  }

  /** True while the game is held up waiting for the other side (for longer than `ms`). */
  waiting(now, ms = 0) {
    return this.waitingSince !== null && now - this.waitingSince >= ms;
  }

  // ---- frames
  writeLocal() {
    const target = this.frame + this.delay;
    if (this.localNext > target) return; // the delay just shrank: this frame's input is already set
    const v = this.readInput();
    // the delay just grew: the frames in between get the same keys (the presses go in the first)
    for (let first = true; this.localNext <= target; first = false) this.inputs[this.me][this.localNext++ % RING] = first ? v : v & HELD;
  }
  play(replay) {
    const f = this.frame, i = f % RING;
    this.states[f % STATES] = { f, s: this.save() };
    const mine = this.inputs[this.me][i], theirs = f <= this.remoteHave ? this.inputs[1 - this.me][i] : this.lastRemote & HELD;
    this.used[i] = theirs;
    if (this.me === 0) this.step(mine, theirs, f, replay);
    else this.step(theirs, mine, f, replay);
    this.frame++;
    if (!replay) this.stats.frames++;
  }
  // an input of theirs turned out different from what a played frame assumed: rewind there and play forward again
  replay() {
    const from = this.replayFrom;
    this.replayFrom = Infinity;
    if (from >= this.frame) return;
    const to = this.frame, saved = this.states[from % STATES];
    // (cannot happen within maxPredict; if it ever does, the desync check puts things right)
    if (!saved || saved.f !== from) return void console.warn(`[rollback] no saved state for frame ${from} (now ${to})`);
    this.beforeReplay(from, to);
    this.load(saved.s);
    this.frame = from;
    while (this.frame < to) this.play(true);
    this.afterReplay(from);
    this.stats.replays++;
    this.stats.replayed += to - from;
    this.stats.maxReplay = Math.max(this.stats.maxReplay, to - from);
  }

  // ---- network
  sendInputs(now) {
    const t = this.now(), start = this.ackMine + 1, count = Math.max(0, Math.min(this.localNext - start, PER_PACKET));
    const buf = new ArrayBuffer(HEADER + count * 2), v = new DataView(buf);
    const [sumF, sumH, sumG] = this.lastSum ?? [-1, 0, 0];
    v.setUint8(0, T_INPUT);
    v.setUint8(1, sumG & 0xff);
    v.setUint16(2, count, true);
    v.setInt32(4, start, true);
    v.setInt32(8, this.remoteHave, true);
    v.setInt32(12, this.frame, true);
    v.setInt32(16, sumF, true);
    v.setUint32(20, sumH, true);
    v.setFloat64(24, t, true);
    v.setFloat64(32, this.echo, true);
    v.setFloat32(40, this.echo < 0 ? 0 : t - this.echoAt, true);
    v.setUint16(44, Math.min(65535, Math.round((this.acc / DT_MS) * 65535)), true); // how far into the next frame we are
    for (let k = 0; k < count; k++) v.setUint16(HEADER + k * 2, this.inputs[this.me][(start + k) % RING], true);
    this.lastSend = now;
    this.stats.sent++;
    this.send(buf);
  }
  /** Handle a packet from the other side. */
  receive(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER) return;
    const v = new DataView(buf);
    if (v.getUint8(0) !== T_INPUT) return;
    const now = this.now();
    this.stats.received++;
    const gen = v.getUint8(1), count = v.getUint16(2, true), start = v.getInt32(4, true), ack = v.getInt32(8, true), theirFrame = v.getInt32(12, true);
    const sumF = v.getInt32(16, true), sumH = v.getUint32(20, true), ts = v.getFloat64(24, true), echo = v.getFloat64(32, true), hold = v.getFloat32(40, true);
    // the clock comparison: where we are, less where they were when they sent this (both to a fraction of a frame)
    if (this.tickAt !== null) {
      const ours = this.frame + (this.acc + now - this.tickAt) / DT_MS, theirs = theirFrame + v.getUint16(44, true) / 65535;
      this.offsets.push({ at: now, x: ours - theirs });
      while (this.offsets[0].at < now - SYNC_WINDOW) this.offsets.shift();
    }
    if (buf.byteLength < HEADER + count * 2) return;
    // round trip: our own send time, echoed back, less the time it sat on their side
    if (echo >= 0) {
      const rtt = now - echo - hold;
      if (rtt >= 0 && rtt < 5000) {
        this.rtts.push(rtt);
        if (this.rtts.length > 60) this.rtts.shift();
        this.rtt = [...this.rtts].sort((a, b) => a - b)[this.rtts.length >> 1];
      }
    }
    if (ts > this.echo) (this.echo = ts), (this.echoAt = now);
    if (ack > this.ackMine) this.ackMine = Math.min(ack, this.localNext - 1);
    for (let k = 0; k < count; k++) {
      const f = start + k;
      if (f <= this.remoteHave) continue;
      if (f !== this.remoteHave + 1) break; // a gap (cannot happen: they always start at what we confirmed)
      const val = v.getUint16(HEADER + k * 2, true), i = f % RING;
      this.inputs[1 - this.me][i] = val;
      this.remoteHave = f;
      this.lastRemote = val;
      if (f < this.frame && f >= this.floor && this.used[i] !== val) this.replayFrom = Math.min(this.replayFrom, f); // we guessed wrong
    }
    if (sumF >= 0 && gen === this.gen) this.compare(sumF, null, sumH);
  }

  // ---- timing
  // How far ahead of them do we play? Each packet says which frame they were on when they sent it; by the time
  // it arrives they have gone on for the trip's length. The quickest packet of the last moments has the least of
  // that in it (jitter only ever adds), so: our frame less theirs, at its smallest, less half the quickest round
  // trip. The side ahead by over half a frame slows down a little until they are level. It sees its own slowing
  // at once (its offsets shrink, and the smallest is what counts), so it does not overshoot.
  syncTime() {
    if (!this.offsets.length || !this.rtts.length) return;
    let x = Infinity;
    for (const o of this.offsets) x = Math.min(x, o.x);
    this.lead = x - Math.min(...this.rtts) / 2 / DT_MS;
    this.slowing = this.slowing ? this.lead > 0.1 : this.lead > 0.5;
  }
  // input delay from the round trip: none on a LAN, more as it grows (one step at a time, at most every 2 s)
  adaptDelay(now) {
    if (this.fixedDelay !== null || this.rtts.length < 10 || now - this.delayAt < 2000) return;
    const sorted = [...this.rtts].sort((a, b) => a - b), typical = sorted[Math.floor(sorted.length * 0.3)];
    const want = typical <= 20 ? 0 : typical <= 70 ? 1 : typical <= 130 ? 2 : 3;
    if (want !== this.delay) (this.delay += Math.sign(want - this.delay)), (this.delayAt = now);
  }

  // ---- desync check
  check() {
    // a state is final once every input before it is known (and played: replays happen at the start of a tick)
    const final = Math.min(this.remoteHave + 1, this.frame - 1);
    for (; this.sumNext <= final; this.sumNext += SUM_EVERY) {
      const f = this.sumNext, saved = this.states[f % STATES];
      if (!saved || saved.f !== f) continue;
      const h = this.hash(saved.s) >>> 0;
      this.lastSum = [f, h, this.gen];
      this.compare(f, h, null);
    }
  }
  compare(f, mine, theirs) {
    const e = this.sums.get(f) ?? { mine: null, theirs: null, done: false };
    if (mine !== null) e.mine = mine;
    if (theirs !== null) e.theirs = theirs;
    this.sums.set(f, e);
    if (!e.done && e.mine !== null && e.theirs !== null) {
      e.done = true;
      if (e.mine !== e.theirs) (this.stats.desyncs++, this.onDesync(f));
    }
    if (this.sums.size > 40) for (const k of this.sums.keys()) if (k < f - 30 * SUM_EVERY) this.sums.delete(k);
  }
  /** The latest frame whose state is final, with that state (the host sends this on a desync). A replay still
   *  waiting for the next tick means the states from its frame on were played with a wrong guess: stop there. */
  finalState() {
    const f = Math.max(0, Math.min(this.remoteHave + 1, this.frame - 1, this.replayFrom)), saved = this.states[f % STATES];
    return saved && saved.f === f ? saved : null;
  }
  /** Take the host's state for frame f as the truth (gen: the host's resync count). */
  resync(f, s, gen) {
    this.gen = gen & 0xff;
    this.stats.resyncs++;
    for (const k of [...this.sums.keys()]) if (k >= f - SUM_EVERY * 30) this.sums.delete(k);
    this.lastSum = null;
    this.sumNext = (Math.floor(f / SUM_EVERY) + 1) * SUM_EVERY;
    if (f < this.frame - RING + this.maxPredict) return; // far too old to replay from: wait for a newer one
    this.states[f % STATES] = { f, s };
    // the host's state replaces whatever we had up to f: a replay from before f would bring ours back, and so
    // would a late input for a frame before f (we may have guessed it wrong, but that is settled now)
    this.floor = f;
    if (f < this.frame) this.replayFrom = f;
    else {
      // the host is ahead of us: jump to its frame
      this.replayFrom = Infinity;
      this.load(s);
      this.frame = f;
      if (this.localNext < f) {
        for (let k = this.localNext; k < f; k++) this.inputs[this.me][k % RING] = 0;
        this.localNext = f;
      }
      if (this.remoteHave < f - 1) {
        for (let k = this.remoteHave + 1; k < f; k++) this.inputs[1 - this.me][k % RING] = this.lastRemote & HELD;
        this.remoteHave = f - 1;
      }
    }
  }
  /** The host counts the resyncs it sends, so a check made before one is not mistaken for a new desync. */
  bumpGen() {
    this.gen = (this.gen + 1) & 0xff;
    for (const k of [...this.sums.keys()]) if (k >= this.sumNext - SUM_EVERY * 30) this.sums.delete(k);
    this.lastSum = null;
    return this.gen;
  }
}
