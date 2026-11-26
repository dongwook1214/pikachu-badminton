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
const { game, P1, P2, S, step, pressed, setAI, setArena, tagOf } = globalThis.__pika;
const frame = () => { step(1 / 60); pressed.clear(); };

test('in AI vs AI each side is tagged with its AI name', () => {
  setArena('unlimited:dragon', 'unlimited:cpu', 1);
  assert.equal(tagOf(P1), 'DRAGON');
  assert.equal(tagOf(P2), 'CPU');
  setAI('normal');
  assert.equal(tagOf(P1), '1P');
  assert.equal(tagOf(P2), 'CPU');
});

// 1P has just scored the winning point (the shuttle is down): the game ends once the point's pause (and any
// gloating) is over
function winningPoint() {
  Object.assign(game, { state: 'point', pointWinner: P1, timer: 0.001, freeze: 0, paused: false });
  S.state = 'dead';
  P1.score = 11;
  for (let i = 0; i < 600 && game.state === 'point'; i++) frame();
  assert.equal(game.state, 'over');
  return game.msg.text;
}

test('the winner of an AI vs AI game is named', () => {
  setArena('unlimited:dragon', 'unlimited:cpu', 1);
  assert.equal(winningPoint(), 'DRAGON WINS!');
  setAI('normal');
  assert.equal(winningPoint(), '1P WINS!');
});
