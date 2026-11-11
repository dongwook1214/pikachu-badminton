// Hash the exact bits of many results from badminton/detmath.js, including whole shuttle flights computed the
// way game.js does. Run by tests/detmath.test.mjs under Node (V8, as in Chrome) and jsc (JavaScriptCore, as in
// Safari): the two hashes must match, or online games between those browsers would drift apart.
import { dsin, dcos, datan2, dhypot } from "../badminton/detmath.js";

const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
let h = 0x811c9dc5;
const mix = (x) => {
  f64[0] = x + 0; // -0 hashes as 0
  for (const w of u32) {
    h = Math.imul(h ^ w, 0x01000193);
    h ^= h >>> 15;
  }
};

// a small fixed PRNG so both engines see the same inputs
let s = 12345;
const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);

for (let i = 0; i < 20000; i++) {
  const a = (rnd() - 0.5) * 40, b = (rnd() - 0.5) * 400, c = (rnd() - 0.5) * 400;
  mix(dsin(a));
  mix(dcos(a));
  mix(datan2(b, c));
  mix(dhypot(b, c));
}

// shuttle flights, as game.js flies them: quadratic drag, 4 substeps per 1/60 s frame
const SH_G = 420, SH_K = 0.0028, FLOOR = 196, NET_X = 192, NET_TOP = 160, DT = 1 / 60;
for (let n = 0; n < 300; n++) {
  const face = rnd() < 0.5 ? 1 : -1, x0 = 40 + rnd() * 300, y0 = 100 + rnd() * 80;
  let ang = -20 - rnd() * 50;
  const ahead = (NET_X - x0) * face;
  if (ahead > 4) ang = Math.min(20, (datan2(NET_TOP - 10 - y0, ahead) * 180) / Math.PI - 3);
  const r = (ang * Math.PI) / 180, sp = 200 + rnd() * 400;
  let x = x0, y = y0, vx = dcos(r) * sp * face, vy = dsin(r) * sp;
  for (let t = 0; t < 240 && y < FLOOR; t++) {
    for (let k = 0; k < 4; k++) {
      const h4 = DT / 4, v = dhypot(vx, vy);
      vx += -SH_K * v * vx * h4;
      vy += (SH_G - SH_K * v * vy) * h4;
      x += vx * h4;
      y += vy * h4;
    }
  }
  mix(x);
  mix(y);
  mix(vx);
  mix(vy);
}
// the serve bob: S.y = s.y - 30 + sin(game.time * 4) * 1.5, game.time stepping by 1/60 for an hour
let time = 0;
for (let i = 0; i < 216000; i++) {
  time += DT;
  if (i % 97 === 0) mix(dsin(time * 4));
}

(typeof print === "function" ? print : console.log)((h >>> 0).toString(16)); // print: jsc, console.log: Node
