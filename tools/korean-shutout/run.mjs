import assert from "node:assert/strict";
import { match } from "./load-game.mjs";
import { makePilot } from "./pilot.mjs";

const DT = 1 / 60;
const NET_X = 192;
const [gameSeed = 1728, cpuSeed = 1] = process.argv.slice(2).map(Number);
const random = Math.random;
let rng = cpuSeed >>> 0;
// CPU choices use Math.random(); seed it only in this offline harness.
Math.random = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 2 ** 32;
try {
  const { game, P1, P2, S, keyDown, keyUp, pressed, setAI, step } = match;
  setAI("korean");
  game.rng = gameSeed >>> 0;
  const allowed = new Set(["Enter", "KeyA", "KeyD", "KeyW", "KeyF", "KeyS", "KeyH"]);
  const pilot = makePilot({ game, P1, P2, S, bolts: match.bolts }, (type, key) => {
    assert.ok(allowed.has(key), `Unexpected 1P input: ${key}`);
    if (type === "keydown") keyDown(key);
    else keyUp(key);
  });
  let maxX = P1.x,
    returns = 0,
    smashes = 0,
    onCourtWinners = 0,
    owner = null;
  let initialServer;
  keyDown("Enter");
  keyUp("Enter");
  for (let frame = 0; frame < 14_400 && game.state !== "over"; frame++) {
    const p1Score = P1.score;
    step(DT);
    pressed.clear();
    initialServer ??= game.server.id;
    maxX = Math.max(maxX, P1.x);
    if (S.last === P1 && owner !== P1) {
      returns++;
      if (S.smash > 0) smashes++;
    }
    owner = S.last;
    if (P1.score > p1Score && S.last === P1 && S.x > NET_X && S.x <= 368) onCourtWinners++;
    pilot.tick();
  }
  const score = [P1.score, P2.score];
  console.log(
    JSON.stringify({
      gameSeed,
      cpuSeed,
      initialServer,
      score,
      maxX: +maxX.toFixed(2),
      contacts: returns,
      smashes,
      onCourtWinners,
      state: game.state,
    }),
  );
  assert.equal(game.state, "over", "the match finishes within the frame budget");
  assert.deepEqual(score, [11, 0]);
  assert.ok(maxX < NET_X, "1P never crosses the net");
  assert.equal(onCourtWinners, 11, "every point comes from a 1P shot landing in the 2P court");
  assert.ok(smashes > 0, "the pilot uses Iron Tail");
} finally {
  Math.random = random;
}
