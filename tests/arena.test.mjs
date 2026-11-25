import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const arena = (...args) => spawnSync(process.execPath, [new URL('../tools/arena.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' });

test('two AIs play whole games from both sides, and a clear winner passes', () => {
  const r = arena('hard', 'easy', '--seeds', '2');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /hard vs easy: 4 wins, 0 losses of 4 -> BEATS easy/);
  assert.match(r.stdout, /seed {2}1 {2}hard \(1P\) .* easy \(2P\)/);
  assert.match(r.stdout, /seed {2}1 {2}easy \(1P\) .* hard \(2P\)/);
});

test('an AI against itself wins exactly half: each seed plays out the same from either side', () => {
  const r = arena('cpu', 'cpu', '--seeds', '3');
  assert.match(r.stdout, /cpu vs cpu: 3 wins, 3 losses of 6 -> does not beat cpu/);
});

test('the same command gives the same games every time', () => {
  const a = arena('korean', 'cpu', '--seeds', '2'), b = arena('korean', 'cpu', '--seeds', '2');
  assert.equal(a.stdout, b.stdout);
  assert.doesNotMatch(a.stdout, /unfinished/);
});

test('losing to an opponent fails, and an unknown AI is an error', () => {
  assert.equal(arena('easy', 'hard', '--seeds', '1').status, 1);
  const r = arena('nobody');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown AI "nobody"/);
});
