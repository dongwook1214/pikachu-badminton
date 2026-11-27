import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const frames = [];
let workers = 0, paints = 0;
Object.assign(globalThis, {
  window: globalThis,
  location: { search: '' },
  document: {
    getElementById: (id) => id === 'screen' ? { getContext: () => ({ fillRect() {}, putImageData() { paints++; } }) } : null,
    querySelectorAll: () => [],
  },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  requestAnimationFrame: (fn) => frames.push(fn),
  Worker: class { constructor() { workers++; } },
  ImageData: class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } },
  fetch: async (url) => new Response(await readFile(new URL(`../badminton/${url}`, import.meta.url))),
});
await import('../badminton/game.js');
const live = globalThis.__pika;

test('the scheduled browser loop advances and paints when Return Blend is not selected', () => {
  assert.equal(live.ai.on, false);
  assert.equal(workers, 1);
  const start = performance.now() + 40;
  for (let frame = 0; frame < 3; frame++) {
    assert.equal(frames.length, 1);
    const before = live.game.time;
    frames.shift()(start + frame * 20);
    assert.ok(live.game.time > before, 'the simulation clock should advance');
  }
  assert.equal(paints, 3);
  assert.equal(frames.length, 1);
});

test('Return Blend only adds its own input and resets its brain between matches', () => {
  const level = 'unlimited:return-blend';
  assert.equal(live.aiLevels[level].pow, 1);
  live.setArena(level, level, 1);
  live.keyDown('Enter');
  live.keyUp('Enter');
  live.step(1 / 60);
  const first = live.ai.returnBlend;
  assert.equal(typeof first, 'function');
  assert.equal(live.held.size, 0, 'AI input must not use the human keyboard');
  assert.ok(live.P1.src !== live.P2.src);
  live.setArena(level, level, 1);
  assert.equal(live.ai.returnBlend, null);
  live.keyDown('Enter');
  live.keyUp('Enter');
  live.step(1 / 60);
  assert.equal(typeof live.ai.returnBlend, 'function');
  assert.notEqual(live.ai.returnBlend, first);
});

test('Return Blend wins full games to eleven from both sides at base stats', () => {
  const tool = fileURLToPath(new URL('../tools/arena.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [tool, 'return-blend', '--seeds', '1'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /return-blend \(1P\) 11:\d+ cpu \(2P\)\s+return-blend win/);
  assert.match(result.stdout, /cpu \(1P\) \d+:11 return-blend \(2P\)\s+return-blend win/);
  assert.match(result.stdout, /PASS: return-blend/);
});
