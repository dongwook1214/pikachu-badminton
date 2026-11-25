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
  },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  requestAnimationFrame() {},
  ImageData: class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } },
  Worker: class {},
  fetch: async (name) => new Response(await readFile(new URL(`../badminton/${name}`, import.meta.url))),
});
await import('../badminton/game.js');
const { game, P1, P2, S, step, pressed, held, setAI, toTitle } = globalThis.__pika;
const frame = () => { step(1 / 60); pressed.clear(); };

function fastSmash(level) {
  held.clear();
  pressed.clear();
  toTitle();
  setAI(null);
  Object.assign(game, { state: 'rally', freeze: 0 });
  Object.assign(P2, { x: 312, face: -1 });
  // An Iron Tail from (181, 144) has the default 20-degree launch toward 2P.
  const angle = Math.PI / 9;
  Object.assign(S, { state: 'fly', last: P1, smash: 1, x: 181, y: 144,
    vx: 560 * Math.cos(angle), vy: 560 * Math.sin(angle) });
  // Let the trajectory enter the time-critical window without CPU movement.
  for (let i = 0; i < 13; i++) frame();
  assert.equal(S.state, 'fly');
  setAI(level);
  frame();
  const startedSwing = P2.act?.type === 'basic';
  frame();
  return { startedSwing, returned: S.last === P2, leftward: S.vx < 0 };
}

test('Korean CPU starts an early ground block and returns a fast Iron Tail', () => {
  assert.deepEqual(fastSmash('korean'), { startedSwing: true, returned: true, leftward: true });
});

test('Extreme CPU does not use the Korean-only early block', () => {
  assert.deepEqual(fastSmash('extreme'), { startedSwing: false, returned: false, leftward: false });
});
