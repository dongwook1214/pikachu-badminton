// AI: Claude Opus 5.5
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Load the actual game and assets, with only its browser UI and frame loop stubbed.
Object.assign(globalThis, {
  window: globalThis,
  location: { search: '' },
  document: {
    getElementById: (id) => id === 'screen' ? { getContext: () => ({}) } : null,
    querySelectorAll: () => [],
    querySelector: () => null,
  },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  requestAnimationFrame() {},
  ImageData: class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } },
  Worker: class {},
  fetch: async (name) => new Response(await readFile(new URL(`../badminton/${name}`, import.meta.url))),
});
await import('../badminton/game.js');
const { game, P1, P2, S, step, pressed, held, setAI, toTitle, aiLevels } = globalThis.__pika;
const frame = () => { step(1 / 60); pressed.clear(); };

// 1P (standing still at the back) drives the shuttle from (97, 162) over the net, high, towards 2P at x 275. Plays it
// out until 2P hits it, then until it lands. Math.random is seeded, so it plays out the same every time.
function highReturn(level) {
  const random = Math.random;
  let rng = 7;
  Math.random = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  try {
    held.clear();
    pressed.clear();
    toTitle();
    setAI(null);
    Object.assign(game, { state: 'rally', freeze: 0 });
    Object.assign(P1, { x: 71, face: 1 });
    Object.assign(P2, { x: 275, face: -1 });
    Object.assign(S, { state: 'fly', last: P1, smash: 0, x: 97, y: 162, vx: 405, vy: -157 });
    setAI(level);
    for (let i = 0; i < 120 && S.last === P1 && S.state === 'fly'; i++) frame();
    const met = { returned: S.last === P2, smash: S.smash > 0, x: S.x };
    for (let i = 0; i < 200 && S.state === 'fly'; i++) frame();
    return { ...met, landed: S.x, winner: game.pointWinner };
  } finally {
    Math.random = random;
  }
}

test('lookahead jumps to smash a high shuttle at the net, and it lands in', () => {
  const r = highReturn('unlimited:dragon');
  assert.equal(r.returned, true);
  assert.equal(r.smash, true, 'met in the air: Iron Tail');
  assert.ok(r.x < 200, `met right at the net (x ${r.x.toFixed(1)})`);
  assert.ok(r.landed > 16 && r.landed < 192, `landed in 1P's court (x ${r.landed.toFixed(1)})`);
  assert.equal(r.winner, P2);
});

test('without lookahead the same algorithm lets it come deep and plays it from the floor', () => {
  const L = aiLevels['unlimited:dragon'];
  L.lookahead = false;
  try {
    const r = highReturn('unlimited:dragon');
    assert.equal(r.returned, true);
    assert.equal(r.smash, false);
    assert.ok(r.x > 260, `met deep in its court (x ${r.x.toFixed(1)})`);
  } finally {
    L.lookahead = true;
  }
});

test('dragon (lookahead) plays from either side: it beats cpu as 1P and as 2P', () => {
  const r = spawnSync(process.execPath, [new URL('../tools/arena.mjs', import.meta.url).pathname, 'dragon', 'cpu', '--seeds', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /dragon vs cpu: 2 wins, 0 losses of 2 -> BEATS cpu/);
});
