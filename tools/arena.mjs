// AI arena: plays one AI against others, both sides run by AIs, and says whether it beats them all.
//
//   node tools/arena.mjs <challenger> [opponent ...] [--seeds N]
//
// AIs are named by their AI Unlimited id (cpu) or a built-in level (easy, normal, hard, extreme, korean).
// With no opponents named, the challenger meets every AI on the AI Unlimited list but itself.
// Each seed is played twice, once from each side, to 11 points like a normal game. A seed decides which side serves
// first, so in one game of the two the challenger serves first and in the other its opponent does (between AIs the
// receiver wins most points, so this matters). Every game is seeded (the game's own random numbers and Math.random,
// which the AIs use), so the same command always gives the same results.
// The challenger beats an opponent when it wins more than half of their games, and passes when it beats every one.
// Exit code 0 on a pass, 1 otherwise.
import { readFile } from "node:fs/promises";

// Load the actual game and assets, with only its browser UI and frame loop stubbed.
Object.assign(globalThis, {
  window: globalThis,
  location: { search: "" },
  document: {
    getElementById: (id) => (id === "screen" ? { getContext: () => ({}) } : null),
    querySelectorAll: () => [],
    querySelector: () => null,
  },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  requestAnimationFrame() {},
  ImageData: class {
    constructor(w, h) {
      this.data = new Uint8ClampedArray(w * h * 4);
    }
  },
  Worker: class {},
  fetch: async (name) => new Response(await readFile(new URL(`../badminton/${name}`, import.meta.url))),
});
await import("../badminton/game.js");
const { game, P1, P2, step, pressed, keyDown, keyUp, setArena, aiLevels, unlimited } = globalThis.__pika;

const DT = 1 / 60;
const MAX_FRAMES = 60 * 60 * 10; // a game still going after 10 minutes of play counts as a win for neither side

const args = process.argv.slice(2);
const seedsAt = args.indexOf("--seeds");
const seeds = seedsAt >= 0 ? Number(args.splice(seedsAt, 2)[1]) : 10;
const builtIn = Object.keys(aiLevels).filter((k) => !aiLevels[k].unlimited);
const levelOf = (id) => {
  const level = aiLevels[`unlimited:${id}`] ? `unlimited:${id}` : aiLevels[id] && !aiLevels[id].unlimited ? id : null;
  if (!level) {
    console.error(`Unknown AI "${id}". AI Unlimited: ${unlimited.map((u) => u.id).join(", ")}. Built in: ${builtIn.join(", ")}.`);
    process.exit(2);
  }
  return level;
};
if (!args.length || !(seeds >= 1)) {
  console.error("usage: node tools/arena.mjs <challenger> [opponent ...] [--seeds N]");
  process.exit(2);
}
const [challenger, ...named] = args;
levelOf(challenger);
const opponents = named.length ? named : unlimited.map((u) => u.id).filter((id) => id !== challenger);
opponents.forEach(levelOf);
if (!opponents.length) {
  console.error(`No one for ${challenger} to play: name an opponent.`);
  process.exit(2);
}

// one game, to the end: returns the score as [1P, 2P] and whether it finished
function play(p1, p2, seed) {
  let rng = seed >>> 0;
  const random = Math.random;
  Math.random = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  try {
    setArena(levelOf(p1), levelOf(p2), seed);
    keyDown("Enter");
    keyUp("Enter");
    let frame = 0;
    for (; frame < MAX_FRAMES && game.state !== "over"; frame++) {
      step(DT);
      pressed.clear();
    }
    return { score: [P1.score, P2.score], over: game.state === "over" };
  } finally {
    Math.random = random;
  }
}

console.log(`arena: ${challenger} vs ${opponents.join(", ")}, ${seeds} seeds x 2 sides`);
let pass = true;
for (const opponent of opponents) {
  let wins = 0, losses = 0, unfinished = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    for (const side of [1, 2]) {
      const [p1, p2] = side === 1 ? [challenger, opponent] : [opponent, challenger];
      const { score, over } = play(p1, p2, seed);
      const mine = score[side - 1], theirs = score[2 - side];
      const result = !over ? "unfinished" : mine > theirs ? "win" : "loss";
      if (result === "win") wins++;
      else if (result === "loss") losses++;
      else unfinished++;
      console.log(`  seed ${String(seed).padStart(2)}  ${p1} (1P) ${score[0]}:${score[1]} ${p2} (2P)  ${challenger} ${result}`);
    }
  }
  const games = seeds * 2, beat = wins > games / 2;
  pass &&= beat;
  console.log(`${challenger} vs ${opponent}: ${wins} wins, ${losses} losses${unfinished ? `, ${unfinished} unfinished` : ""} of ${games} -> ${beat ? "BEATS" : "does not beat"} ${opponent}`);
}
console.log(pass ? `PASS: ${challenger} beats every opponent` : `FAIL: ${challenger} does not beat every opponent`);
process.exit(pass ? 0 : 1);
