import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

let listeners = 0, frameRequests = 0, workers = 0;
Object.assign(globalThis, {
  window: globalThis,
  location: { search: '' },
  document: {
    getElementById: (id) => id === 'screen' ? { getContext: () => ({}) } : null,
    querySelectorAll: () => [],
  },
  matchMedia: () => ({ matches: false }),
  addEventListener: () => listeners++,
  requestAnimationFrame: () => frameRequests++,
  Worker: class { constructor() { workers++; } },
  ImageData: class {},
  fetch: async (url) => new Response(await readFile(new URL(`../badminton/${url}`, import.meta.url))),
});
await import('../badminton/game.js');
const { forecastEngine: forecast } = await import('../badminton/game.js?forecast');
const live = globalThis.__pika;

test('forecast has its own state, inputs and randomness, and does not bind the browser twice', () => {
  assert.deepEqual([listeners, frameRequests, workers], [3, 1, 1]);
  assert.notEqual(forecast.P1, live.P1);
  assert.notEqual(forecast.held, live.held);
  const before = live.saveState(), random = Math.random;
  forecast.withForecastRandom(1728, () => {
    forecast.loadState(before);
    forecast.keyDown('Enter');
    forecast.step(1 / 60);
    forecast.pressed.clear();
    forecast.held.clear();
  });
  assert.equal(globalThis.__pika, live);
  assert.equal(Math.random, random);
  assert.equal(live.held.size, 0);
  assert.equal(live.pressed.size, 0);
  assert.deepEqual(live.saveState(), before);
  assert.equal(live.aiLevels['unlimited:return-blend'].pow, 1);
});

test('Return Blend plays to eleven from either side at base stats', () => {
  const tool = fileURLToPath(new URL('../tools/arena.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [tool, 'return-blend', '--seeds', '1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /return-blend \(1P\) 11:0 cpu \(2P\)/);
  assert.match(result.stdout, /cpu \(1P\) 0:11 return-blend \(2P\)/);
  assert.match(result.stdout, /PASS: return-blend/);
});
