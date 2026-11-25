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
const { game, P1, P2, S, step, pressed, held, keyDown, keyUp, setAI, toTitle } = globalThis.__pika;
const frame = () => { step(1 / 60); pressed.clear(); };
const tap = (key) => { keyDown(key); keyUp(key); };
function start(level) {
  held.clear();
  pressed.clear();
  toTitle();
  setAI(level);
  game.freeze = 0;

  game.rng = 1; // P1 serves first.
  tap('Enter');
  frame();
  assert.equal(game.server, P1);
}

test('Korean CPU returns a lob toward the left court after 1P dashes past it', () => {
  start('korean');
  keyDown('KeyA');
  tap('KeyF');
  for (let i = 0; i < 10 && S.last !== P1; i++) frame();
  assert.equal(S.last?.id, P1.id);
  keyUp('KeyA');
  keyDown('KeyD');
  for (let i = 0; i < 150 && S.last !== P2 && game.state !== 'point'; i++) {
    if (game.freeze <= 0 && P1.cd.quick <= 0 && P1.quickT <= 0 && P1.x < 350) tap('KeyH');
    frame();
  }
  keyUp('KeyD');
  assert.ok(P1.x > P2.x, '1P crossed to the far side before the CPU made contact');
  assert.equal(S.last?.id, P2.id, 'the CPU gets to the lob');
  assert.ok(S.vx < 0, 'the CPU returns toward its opponent’s court, not toward the avatar');
});

test('local two-player mode still lets 2P face 1P after a crossing', () => {
  start(null);
  tap('KeyF');
  frame(); frame();
  assert.equal(S.last?.id, P1.id);
  P1.x = 355;
  for (let i = 0; i < 8; i++) frame();
  assert.equal(P2.face, 1);
});
