import assert from 'node:assert/strict';
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
const { game, P2, S, step, pressed, held, setAI, toTitle, aiLevels, unlimited } = globalThis.__pika;
const frame = () => { step(1 / 60); pressed.clear(); };

test('every AI Unlimited entry has a name, an author and plays at the base stats', () => {
  assert.ok(unlimited.length >= 1);
  for (const u of unlimited) {
    const L = aiLevels[`unlimited:${u.id}`];
    assert.ok(u.name && u.ko && u.by, `${u.id} is described`);
    assert.equal(L.pow, 1, `${u.id} plays at the base stats`);
    assert.equal(L.unlimited, true);
  }
  assert.equal(aiLevels.korean.pow, 1.15, 'the Korean level itself keeps its boost');
});

// A fast Iron Tail from (181, 144) at the default 20-degree launch toward 2P, which stands at x 308 (where the base-stats reach is a frame short).
function fastSmash(level) {
  held.clear();
  pressed.clear();
  toTitle();
  setAI(null);
  Object.assign(game, { state: 'rally', freeze: 0 });
  Object.assign(P2, { x: 308, face: -1 });
  const angle = Math.PI / 9;
  Object.assign(S, { state: 'fly', last: globalThis.__pika.P1, smash: 1, x: 181, y: 144,
    vx: 560 * Math.cos(angle), vy: 560 * Math.sin(angle) });
  // let the shuttle come to the frame where only an early swing can meet it, without the CPU moving
  for (let i = 0; i < 13; i++) frame();
  assert.equal(S.state, 'fly');
  setAI(level);
  frame();
  const startedSwing = P2.act?.type === 'basic';
  frame();
  return { startedSwing, returned: S.last === P2, leftward: S.vx < 0 };
}

test('cpu swings a frame early and returns a fast Iron Tail', () => {
  assert.deepEqual(fastSmash('unlimited:cpu'), { startedSwing: true, returned: true, leftward: true });
});

test('without blockSmash the same algorithm lets that smash through', () => {
  const L = aiLevels['unlimited:cpu'];
  L.blockSmash = false;
  try {
    assert.deepEqual(fastSmash('unlimited:cpu'), { startedSwing: false, returned: false, leftward: false });
  } finally {
    L.blockSmash = true;
  }
});
