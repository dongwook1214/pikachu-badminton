// Pika Badminton: a two-player badminton brawl. Personal fan project.
// Rendering and effects use pixelfx (vendor/pixelfx, MIT): one 384x216 pixel frame with a color and a light buffer.
import { createFrame, clearFrame, createFx, composite, painterFor, hex, PAL, fit, rng, clamp } from "./vendor/pixelfx/src/core/index.js";
import * as hitSpark from "./vendor/pixelfx/src/fx/impacts/hit-spark.js";
import * as critHit from "./vendor/pixelfx/src/fx/impacts/crit-hit.js";
import * as bluntHit from "./vendor/pixelfx/src/fx/impacts/blunt-hit.js";
import * as zapHit from "./vendor/pixelfx/src/fx/lightning/zap-hit.js";
import * as electrified from "./vendor/pixelfx/src/fx/lightning/electrified.js";
import * as spinSlash from "./vendor/pixelfx/src/fx/melee/spin-slash.js";
import * as stunnedFx from "./vendor/pixelfx/src/fx/status/stunned.js";
import { zigzag, crackle } from "./vendor/pixelfx/src/fx/lightning/_lib.js";
// the game's own math goes through detmath.js so that two browsers playing online stay identical (rollback.js)
import { dsin, dcos, datan2, dhypot } from "./detmath.js";
import { Rollback } from "./rollback.js";

// ---------------------------------------------------------------- world
const W = 384, H = 216, FLOOR = 196, NET_X = 192, NET_TOP = 160, NET_BOTTOM = 184, COURT_L = 16, COURT_R = 368;
const GRAV = 900, JUMP_V = 330, RUN = 115;
const SH_G = 420, SH_K = 0.0028;              // shuttle gravity and quadratic drag (tuned in a sim)
const WIN = 11;
const SERVE_GAP = 12; // during the serve, how close to the net a player's center may get
const SQUASH = { rate: 16 }; // Down held: how fast the squash eases in and out (the frames are hand-drawn)
const SERVICE_LINE = 56; // the short service lines sit this far either side of the net; the server stays behind theirs
const DT = 1 / 60;

// move timings (seconds)
const BASIC = { dur: 0.26, on: 0.03, off: 0.16, reachS: 21, reachP: 14 };
const TAIL = { dur: 0.5, on: 0.12, off: 0.3, cd: 1.6, reachS: 24, reachP: 19 };
const ZAP = { dur: 0.24, fire: 0.07, cd: 1.2, speed: 250, noHit: 0.3 }; // noHit: no shuttle hits this long after a zap
const QUICK = { dur: 0.15, speed: 470, cd: 0.9 };
const STUN = { basic: 0.2, zap: 0.4, tail: 0.5 };

const C = (h) => hex(h);
const VOLT = fit(PAL.volt, 8);
const WHITE = C("#ffffff"), INK = C("#0b0a12");

// ---------------------------------------------------------------- sprites
// players: pikachu_grid.json (art/pikachu_pixel.py); the CPU opponent: cpu_grid.json (art/cpu_pixel.py, original)
// A sprite: trimmed rows, its palette, the offset that puts its feet at (0, 0), and a pixelfx actor (mask +
// pixels) for the effects that wrap a body (electrified, stunned). squash: hand-drawn frames for holding Down
// (halfway, then flat), each trimmed the same way.
function trimFrame(g) {
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  g.rows.forEach((r, y) => [...r].forEach((ch, x) => {
    if (ch !== ".") (x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y));
  }));
  const rows = g.rows.slice(y0, y1 + 1).map((r) => r.slice(x0, x1 + 1));
  return { rows, ax: -(g.center_x - x0), ay: -rows.length };
}
function makeSprite(g) {
  const { rows, ax, ay } = trimFrame(g);
  const w = rows[0].length, h = rows.length;
  const mask = { w, h, data: new Uint8Array(w * h) }, pixels = new Uint32Array(w * h);
  rows.forEach((r, y) => [...r].forEach((ch, x) => {
    if (ch === ".") return;
    mask.data[y * w + x] = 1;
    pixels[y * w + x] = C(g.palette[ch]);
  }));
  const actor = { mask, pixels, x: ax, y: ay, w, h, k: 2, head: [0, ay], chest: [0, Math.round(ay * 0.55)] };
  return { rows, pal: { ...g.palette }, ax, ay, actor, squash: (g.squash ?? []).map(trimFrame) };
}
const [pikaGrid, cpuGrid] = await Promise.all(["./pikachu_grid.json", "./cpu_grid.json"].map((u) => fetch(u).then((r) => r.json())));
const SPR_P1 = makeSprite(pikaGrid);
const SPR_P2 = { ...SPR_P1, pal: { ...SPR_P1.pal, Y: "#ffc23a", t: "#ffc23a", O: "#dc8c14" } };
const SPR_CPU = makeSprite(cpuGrid);
const STEEL = { t: "#d6deee", k: "#2c3246", B: "#8890a6" };
const CHEEK_ZAP = { R: "#fff7a8", P: "#e8f6ff" };
const AFTER = { 1: ["#fff3a0", "#d8a030", "#6a4a20"].map(C), 2: ["#ffe08a", "#d08a28", "#64401c"].map(C) };

// ---------------------------------------------------------------- input
const CONTROLS = {
  1: { left: ["KeyA"], right: ["KeyD"], up: ["KeyW"], down: ["KeyS"], basic: ["KeyF"], zap: ["KeyG"], quick: ["KeyH"] },
  2: {
    left: ["ArrowLeft"], right: ["ArrowRight"], up: ["ArrowUp"], down: ["ArrowDown"],
    basic: ["KeyK", "Numpad1"], zap: ["KeyL", "Numpad2"], quick: ["Semicolon", "Numpad3"],
  },
};
// online, each player may use either layout on their own keyboard
const ANY = Object.fromEntries(Object.keys(CONTROLS[1]).map((k) => [k, [...CONTROLS[1][k], ...CONTROLS[2][k]]]));
const START_KEYS = ["Enter", "Space"], PAUSE_KEYS = ["Escape", "KeyP"];
const GAME_KEYS = new Set([...Object.values(ANY).flat(), ...START_KEYS, ...PAUSE_KEYS]);
// input sources: this keyboard; online, each player's keys for the frame being played (see rollback.js)
const LOCAL = { held: new Set(), pressed: new Set() };
const NET_SRC = [{ held: new Set(), pressed: new Set() }, { held: new Set(), pressed: new Set() }];
const held = LOCAL.held, pressed = LOCAL.pressed;
const typing = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
// one path for real keys and the touch buttons (which press the 1P keys for you)
function keyDown(code, repeat = false) {
  if (!repeat) pressed.add(code);
  held.add(code);
}
function keyUp(code) {
  held.delete(code);
}
addEventListener("keydown", (e) => {
  if (typing(e)) return;
  if (GAME_KEYS.has(e.code)) e.preventDefault();
  keyDown(e.code, e.repeat);
});
addEventListener("keyup", (e) => keyUp(e.code));
addEventListener("blur", () => held.clear());
const pHeld = (p, codes) => codes.some((c) => p.src.held.has(c));
const pPressed = (p, codes) => codes.some((c) => p.src.pressed.has(c));
// menu keys (start, pause) count from either player
const anyPressed = (codes) => (net.rb ? NET_SRC : [LOCAL]).some((s) => codes.some((c) => s.pressed.has(c)));

// Online, one player's input for one frame is 16 bits: the seven game keys held (bits 0-6), the same seven
// pressed this frame (bits 8-14), start pressed (bit 7) and pause pressed (bit 15). Either keyboard layout
// counts; inside the game both players then use the 1P key names.
const INPUT_KEYS = ["left", "right", "up", "down", "basic", "zap", "quick"];
function readLocalInput() {
  let v = 0;
  INPUT_KEYS.forEach((k, i) => {
    if (ANY[k].some((c) => held.has(c))) v |= 1 << i;
    if (ANY[k].some((c) => pressed.has(c))) v |= 1 << (i + 8);
  });
  if (START_KEYS.some((c) => pressed.has(c))) v |= 0x80;
  if (PAUSE_KEYS.some((c) => pressed.has(c))) v |= 0x8000;
  pressed.clear();
  return v;
}
function decodeInput(src, v) {
  src.held.clear();
  src.pressed.clear();
  INPUT_KEYS.forEach((k, i) => {
    if (v & (1 << i)) src.held.add(CONTROLS[1][k][0]);
    if (v & (1 << (i + 8))) src.pressed.add(CONTROLS[1][k][0]);
  });
  if (v & 0x80) src.pressed.add(START_KEYS[0]);
  if (v & 0x8000) src.pressed.add(PAUSE_KEYS[0]);
}

// ---------------------------------------------------------------- state
const makePlayer = (id) => ({
  id, ctl: CONTROLS[id], src: LOCAL, spr: id === 1 ? SPR_P1 : SPR_P2, tag: C(id === 1 ? "#ff6b5b" : "#5bb0ff"),
  x: 0, y: FLOOR, vx: 0, vy: 0, face: id === 1 ? 1 : -1, ground: true,
  act: null, cd: { zap: 0, tail: 0, quick: 0 }, quickT: 0, dashX: 0, dashY: 0,
  stun: 0, stunKind: null, stunN: 0, knocked: false, knockT: 0, iframes: 0, noHit: 0,
  trail: [], score: 0, squash: 0,
});
const P1 = makePlayer(1), P2 = makePlayer(2), PLAYERS = [P1, P2];
const other = (p) => (p === P1 ? P2 : P1);
const S = { x: 0, y: 0, vx: 0, vy: 0, state: "serve", last: null, smash: 0, trail: [] };

// rng: the game's own random numbers (who serves first, each bolt's look), kept in the state so that both
// browsers draw the same ones online. Effects and dust are only for show and use Math.random.
const game = { state: "title", server: P1, timer: 0, msg: null, paused: false, winner: null, pointWinner: null, time: 0, freeze: 0, shakeT: 0, shakeA: 0, rng: (Math.random() * 2 ** 32) >>> 0 };
const effects = [], bolts = [], dust = [], marks = [];
function srand() {
  game.rng = (Math.imul(game.rng, 1664525) + 1013904223) >>> 0;
  return game.rng / 2 ** 32;
}

function resetRally(server) {
  game.server = server;
  P1.x = 96; P2.x = 288;
  for (const p of PLAYERS) {
    Object.assign(p, { y: FLOOR, vx: 0, vy: 0, ground: true, act: null, quickT: 0, stun: 0, stunKind: null, knocked: false, iframes: 0, noHit: 0, trail: [] });
    p.cd = { zap: 0, tail: 0, quick: 0 };
    p.face = p === P1 ? 1 : -1;
  }
  bolts.length = 0;
  Object.assign(S, { state: "serve", vx: 0, vy: 0, last: null, smash: 0, trail: [] });
  followServer();
  game.state = "serve";
  say(`${server.id}P SERVE`, server.tag, 1.1);
}
function newGame() {
  P1.score = P2.score = 0;
  marks.length = 0;
  if (!fxLog.replay) effects.length = 0;
  game.winner = null;
  resetRally(srand() < 0.5 ? P1 : P2);
}
function say(text, color = WHITE, dur = 1, y = 52) {
  game.msg = { text, color, t: 0, dur, y };
}
function hitstop(t) {
  game.freeze = Math.max(game.freeze, t);
}
function shake(a, t) {
  game.shakeA = Math.max(game.shakeA, a);
  game.shakeT = Math.max(game.shakeT, t);
}

// ---------------------------------------------------------------- effects
// Effects and dust are only for show: they are not part of the game state, and each browser draws its own.
const MODS = { hitSpark, critHit, bluntHit, zapHit, electrified, spinSlash, stunnedFx };
const MOD_NAME = new Map(Object.entries(MODS).map(([k, v]) => [v, k]));
function addFx(mod, opts, extra = {}) {
  const e = { fx: createFx(mod, { seed: (Math.random() * 1e6) | 0, ...opts }), ...extra };
  effects.push(e);
  return e;
}
// Online, a frame may be played more than once (rollback.js replays frames when the other player's keys turn
// out different from the guess). An effect started in a frame must start only once however often the frame is
// replayed, and one from a frame that turned out differently must go: so each is filed under its frame and its
// place in that frame's order.
const fxLog = { on: false, frame: 0, replay: false, to: 0, count: new Map(), seen: new Map() };
function fxOnce(kind) {
  if (!fxLog.on) return { fresh: true };
  const k = `${fxLog.frame}:${kind}`, n = fxLog.count.get(k) ?? 0;
  fxLog.count.set(k, n + 1);
  const key = `${k}:${n}`, had = fxLog.seen.get(key);
  if (had) return (had.keep = true), { fresh: false, had };
  const rec = { f: fxLog.frame, keep: true, e: null };
  fxLog.seen.set(key, rec);
  return { fresh: true, rec };
}
function spawn(mod, opts, extra = {}) {
  const once = fxOnce(MOD_NAME.get(mod));
  if (!once.fresh) return once.had.e;
  const e = addFx(mod, opts, extra);
  if (once.rec) once.rec.e = e;
  // started in a frame that is being replayed: it is already that many frames old
  if (fxLog.replay) for (let k = Math.min(fxLog.to - fxLog.frame - 1, 12); k > 0; k--) e.fx.update(DT);
  return e;
}
function puff(x, y, n, dir = 0, color = "#b8a890") {
  if (!fxOnce("puff").fresh) return;
  for (let i = 0; i < n; i++)
    dust.push({
      x: x + (Math.random() - 0.5) * 8, y: y - Math.random() * 2,
      vx: (dir || (Math.random() < 0.5 ? -1 : 1)) * (20 + Math.random() * 50), vy: -10 - Math.random() * 30,
      life: 0, max: 0.25 + Math.random() * 0.25, c: C(color), r: Math.random() < 0.4 ? 1 : 0,
    });
}
// a replay is about to play frames from..to-1 again: anything they start is checked off as it comes round again,
// and whatever does not come round again did not happen after all
function fxBeforeReplay(from, to) {
  for (const r of fxLog.seen.values()) if (r.f >= from) r.keep = false;
  Object.assign(fxLog, { replay: true, to });
}
function fxAfterReplay(from) {
  fxLog.replay = false;
  for (const [key, r] of fxLog.seen) {
    if (r.f < from || r.keep) continue;
    fxLog.seen.delete(key);
    const i = r.e ? effects.indexOf(r.e) : -1;
    if (i >= 0) effects.splice(i, 1);
  }
}
function fxForget(before) {
  for (const [key, r] of fxLog.seen) if (r.f < before) fxLog.seen.delete(key);
}
// The effects wrapped round a stunned player (crackling after a zap, dizzy after Iron Tail) follow from the
// state: one per stun (stunN counts them), gone when the stun ends. So a replay cannot leave one behind.
const statusFx = new Map(); // player -> { key, e }
function syncStatus() {
  for (const p of PLAYERS) {
    const kind = p.stun > 0 && p.stunKind === "zap" ? "zap" : p.stun > 0 && p.stunKind === "tail" && !p.knocked ? "tail" : null;
    const key = kind && `${kind}:${p.stunN}`, cur = statusFx.get(p);
    if ((cur?.key ?? null) === key) continue;
    if (cur) {
      const i = effects.indexOf(cur.e);
      if (i >= 0) effects.splice(i, 1);
      statusFx.delete(p);
    }
    if (kind === "zap") statusFx.set(p, { key, e: addFx(electrified, { x: p.x, y: p.y, actor: p.spr.actor, palette: PAL.volt, sparks: ["#ffffff", "#fff6c4", "#ffe066", "#f0b424"] }, { follow: p }) });
    else if (kind === "tail") statusFx.set(p, { key, e: addFx(stunnedFx, { x: p.x, y: p.y, actor: p.spr.actor }, { follow: p }) });
  }
}

// ---------------------------------------------------------------- hits
const hurtbox = (o) => ({ x: o.x, y: o.y - 14, hw: 11, hh: 14 });
function circleBox(cx, cy, r, b) {
  const dx = Math.max(Math.abs(cx - b.x) - b.hw, 0), dy = Math.max(Math.abs(cy - b.y) - b.hh, 0);
  return dx * dx + dy * dy <= r * r;
}
const canBeHit = (o) => !o.knocked && o.iframes <= 0;

function stunPlayer(o, kind, from) {
  o.act = null;
  o.quickT = 0;
  o.trail = [];
  o.stunKind = kind;
  o.stunN++; // (a zap's crackle comes from syncStatus)
  if (kind === "basic") {
    o.stun = STUN.basic;
    o.vx = from.face * 170;
  } else if (kind === "zap") {
    o.stun = STUN.zap;
    o.vx = 0;
    if (!o.ground) o.vy = Math.max(o.vy, 0);
  } else if (kind === "tail") {
    // knocked flying first; the 0.5 s stun starts on landing
    o.knocked = true;
    o.knockT = 0;
    o.stun = 0;
    o.vx = from.face * 270;
    o.vy = -220;
    o.ground = false;
  }
}

// how a hit from (x, y) sends the shuttle off. dir is the direction held: "down" a drop, "fwd" a drive,
// "back" a lob, "" a clear (Iron Tail ignores it)
function shotVel(face, x, y, kind, dir) {
  let sp, ang;
  if (kind === "tail") {
    sp = 560;
    ang = 20;
    const ahead = (NET_X - x) * face; // > 0 when the net is still in front of the shuttle
    if (ahead > 4) ang = Math.min(20, (datan2(NET_TOP - 10 - y, ahead) * 180) / Math.PI - 3);
    ang = Math.max(ang, -40);
  } else {
    // clears, lobs and drives aim ~30 px inside the far baseline: speed fitted in a sim to distance and height
    const dist = face > 0 ? COURT_R - x : x - COURT_L, h = FLOOR - y;
    if (dir === "down") (sp = 220), (ang = -34);
    else if (dir === "fwd") (sp = clamp(40 + 1.607 * dist - 1.283 * h, 260, 560)), (ang = -22);
    else if (dir === "back") (sp = clamp(-217 + 3.302 * dist - 0.453 * h, 300, 640)), (ang = -68);
    else (sp = clamp(-7 + 1.714 * dist - 0.575 * h, 250, 560)), (ang = -52);
  }
  const r = (ang * Math.PI) / 180;
  return { vx: dcos(r) * sp * face, vy: dsin(r) * sp, r };
}

function hitShuttle(p, kind) {
  const c = p.ctl, fwd = pHeld(p, p.face > 0 ? c.right : c.left), back = pHeld(p, p.face > 0 ? c.left : c.right), down = pHeld(p, c.down);
  const { vx, vy, r } = shotVel(p.face, S.x, S.y, kind, down ? "down" : fwd ? "fwd" : back ? "back" : "");
  S.vx = vx;
  S.vy = vy;
  S.state = "fly";
  S.last = p;
  S.smash = kind === "tail" ? 1 : 0;
  game.state = "rally";
  if (kind === "tail") {
    spawn(critHit, { x: S.x, y: FLOOR, height: FLOOR - S.y, flip: p.face < 0, palette: PAL.volt, aim: -r * p.face * 0.6, light: 0.55 });
    hitstop(0.09);
    shake(3, 0.2);
    say("SMASH!", VOLT[5], 0.7, 44);
  } else {
    spawn(hitSpark, { x: S.x, y: FLOOR, height: FLOOR - S.y, flip: p.face < 0, palette: ["#3a2a12", "#8a5a1a", "#d89a2a", "#ffd24a", "#fff09a", "#fffbe0", "#ffffff"] });
    hitstop(0.035);
  }
}

// ---------------------------------------------------------------- players
function startAct(p, type) {
  p.act = { type, t: 0, hitS: false, hitP: false, fired: false, fx: false };
  if (type === "tail") p.cd.tail = TAIL.cd;
  if (type === "zap") (p.cd.zap = ZAP.cd), (p.noHit = ZAP.noHit);
}
// the arrows held at a dash in 8 directions (none: forward). Down only counts in the air.
function dashDir(p, dirX) {
  const ny = pHeld(p, p.ctl.up) ? -1 : pHeld(p, p.ctl.down) && !p.ground ? 1 : 0, nx = dirX || (ny ? 0 : p.face);
  const n = nx && ny ? Math.SQRT1_2 : 1;
  return [nx * n, ny * n];
}
function startQuick(p, dirX) {
  p.cd.quick = QUICK.cd;
  p.act = null;
  p.quickT = QUICK.dur;
  // any of 8 directions, all at full speed and in a straight line (no gravity until it ends, see DASH8)
  [p.dashX, p.dashY] = dashDir(p, dirX);
  p.vx = p.dashX * QUICK.speed * pow(p);
  p.vy = p.dashY * QUICK.speed * pow(p);
  if (p.dashY < 0) p.ground = false;
  if (p.ground || p.dashY < 0) puff(p.x, FLOOR, 6, -Math.sign(p.dashX));
}

// a CPU that boasts (Extreme, Korean) and has just won a point (or the game) gloats; it alone may still move on the game-over screen
const gloating = (p) =>
  ai.on && p === P2 && !!AI_LEVELS[ai.level].taunt && (game.state === "point" ? game.pointWinner : game.state === "over" ? game.winner : null) === P2;
// how much quicker than a person this player is: the Korean CPU runs, dashes and recovers 15% faster and reaches
// 15% further for the shuttle. Online the AI is off, so this is always 1 there.
const pow = (p) => (ai.on && p === P2 ? AI_LEVELS[ai.level].pow ?? 1 : 1);
// Quick Attack goes any of 8 ways. When it ends it keeps this much of its speed up or down.
const DASH8 = { keep: 120 };
const inPlay = (p) => (game.state !== "title" && game.state !== "over") || gloating(p);

function updatePlayer(p, dt) {
  const o = other(p), c = p.ctl, dirX = (pHeld(p, c.right) ? 1 : 0) - (pHeld(p, c.left) ? 1 : 0);
  for (const k in p.cd) p.cd[k] = Math.max(0, p.cd[k] - dt * pow(p));
  p.iframes = Math.max(0, p.iframes - dt);
  p.noHit = Math.max(0, p.noHit - dt);

  const free = !p.knocked && p.stun <= 0;
  if (p.knocked) {
    p.knockT += dt;
    p.vx *= 1 - 1.5 * dt;
  } else if (p.stun > 0) {
    p.stun -= dt;
    p.vx *= 1 - 9 * dt;
    if (p.stun <= 0) {
      p.stun = 0;
      p.stunKind = null;
      p.iframes = 0.25;
    }
  }

  if (free && inPlay(p)) {
    if (!p.act && p.quickT <= 0 && Math.abs(o.x - p.x) > 1) p.face = Math.sign(o.x - p.x);
    if (pPressed(p, c.quick) && p.cd.quick <= 0 && p.quickT <= 0) startQuick(p, dirX);
    else if (!p.act && p.quickT <= 0) {
      // no zaps until the serve is hit
      if (pPressed(p, c.zap) && p.cd.zap <= 0 && game.state !== "serve") startAct(p, "zap");
      else if (pPressed(p, c.basic)) startAct(p, "basic");
    }
    if (pPressed(p, c.up) && p.ground && p.quickT <= 0 && !(p.act && p.act.type === "tail")) {
      p.vy = -JUMP_V;
      p.ground = false;
      puff(p.x, FLOOR, 3);
    }
    if (p.quickT > 0) {
      p.quickT -= dt;
      if (p.quickT <= 0) p.vy = p.dashY * DASH8.keep;
    } else {
      const k = p.act ? (p.act.type === "tail" ? (p.ground ? 0 : 0.5) : 0.55) : 1;
      p.vx = dirX * RUN * k * pow(p);
    }
  }

  // physics
  const dashing = p.quickT > 0;
  if (!dashing) p.vy += GRAV * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  if (p.y < 24) (p.y = 24), (p.vy = Math.max(p.vy, 0)); // (only an 8-way dash from a jump gets this high)
  if (p.y >= FLOOR) {
    if (!p.ground && p.vy > 260) puff(p.x, FLOOR, 4);
    p.y = FLOOR;
    p.vy = 0;
    p.ground = true;
  } else p.ground = false;
  if (p.x < 12 || p.x > W - 12) {
    p.x = clamp(p.x, 12, W - 12);
    if (p.knocked) p.vx *= -0.3;
  }
  // until the serve is hit, each player stays on their own side of the net, and the server stays behind
  // their service line (walking, jumping, Quick Attack or being knocked back all stop at it)
  if (game.state === "serve") {
    const gap = p === game.server ? SERVICE_LINE : SERVE_GAP;
    if (p === P1 && p.x > NET_X - gap) (p.x = NET_X - gap), (p.vx = Math.min(p.vx, 0));
    if (p === P2 && p.x < NET_X + gap) (p.x = NET_X + gap), (p.vx = Math.max(p.vx, 0));
  }
  if (p.knocked && p.ground && p.knockT > 0.05) {
    p.knocked = false;
    p.stun = STUN.tail;
    p.stunKind = "tail";
    p.stunN++; // (the dizzy stars come from syncStatus)
    puff(p.x, FLOOR, 7);
  }

  // hold Down on the ground to squash flat (eased in and out; just for show)
  const squashTo = p.ground && free && inPlay(p) && pHeld(p, c.down) ? 1 : 0;
  p.squash += (squashTo - p.squash) * Math.min(1, dt * SQUASH.rate);

  // after-images while dashing
  if (p.quickT > 0) p.trail.push({ x: p.x, y: p.y, flip: p.face > 0, a: 0.8 });
  for (const g of p.trail) g.a -= dt * 4;
  p.trail = p.trail.filter((g) => g.a > 0).slice(-6);

  // the current move
  const a = p.act;
  if (!a) return;
  a.t += dt;
  if (a.type === "basic" && a.t >= BASIC.on && a.t <= BASIC.off) {
    const hx = p.x + p.face * 12, hy = p.y - 18;
    if (!a.hitS && canHitShuttle(p) && dhypot(S.x - hx, S.y - hy) < BASIC.reachS * pow(p)) {
      a.hitS = true;
      // in the air the swing turns into Iron Tail (a smash), except on the serve: a jump serve is a normal hit
      if (p.ground || S.state === "serve") hitShuttle(p, "basic");
      else ironTail(p);
    }
    if (!a.hitP && canBeHit(o) && circleBox(p.x + p.face * 14, p.y - 16, BASIC.reachP, hurtbox(o))) {
      a.hitP = true;
      stunPlayer(o, "basic", p);
      spawn(hitSpark, { x: o.x - p.face * 6, y: FLOOR, height: FLOOR - (o.y - 16), flip: p.face < 0 });
      hitstop(0.05);
      shake(1, 0.08);
    }
  } else if (a.type === "tail") {
    if (a.t >= TAIL.on && !a.fx) {
      a.fx = true;
      spawn(spinSlash, { x: p.x, y: p.y, flip: p.face < 0, radius: 24, palette: ["#1a1e2c", "#3a4258", "#68728c", "#9aa4bc", "#cfd8ea", "#eef3ff", "#ffffff"], sparks: ["#ffffff", "#fff6c4", "#ffe066", "#f0b424"], light: 0.6 }, { follow: p, keepFlip: true });
      puff(p.x, FLOOR, 4);
    }
    if (a.t >= TAIL.on && a.t <= TAIL.off) {
      const hx = p.x + p.face * 14, hy = p.y - 16;
      if (!a.hitS && canHitShuttle(p) && dhypot(S.x - hx, S.y - hy) < TAIL.reachS * pow(p)) ((a.hitS = true), hitShuttle(p, "tail"));
      if (!a.hitP && canBeHit(o) && circleBox(p.x + p.face * 16, p.y - 10, TAIL.reachP, hurtbox(o))) {
        a.hitP = true;
        stunPlayer(o, "tail", p);
        spawn(bluntHit, { x: o.x - p.face * 4, y: FLOOR, height: FLOOR - (o.y - 14), flip: p.face < 0, light: 0.45 });
        hitstop(0.1);
        shake(3, 0.22);
      }
    }
  } else if (a.type === "zap" && a.t >= ZAP.fire && !a.fired) {
    a.fired = true;
    bolts.push({ owner: p, x: p.x + p.face * 14, y: p.y - 15, vx: p.face * ZAP.speed, life: 1.6, seed: (srand() * 1e6) | 0 });
  }
  if (a.t >= (a.type === "basic" ? BASIC.dur : a.type === "tail" ? TAIL.dur : ZAP.dur)) p.act = null;
}
// Iron Tail has no key of its own: a basic attack that meets the shuttle in mid-air becomes it. Pikachu spins,
// the tail turns to steel and the shuttle is smashed. It only ever hits the shuttle, never the other player.
function ironTail(p) {
  p.act = { type: "tail", t: TAIL.on, hitS: true, hitP: true, fired: false, fx: false };
  hitShuttle(p, "tail");
}
const canHitShuttle = (p) => p.noHit <= 0 && (S.state === "fly" || (S.state === "serve" && game.server === p));

// ---------------------------------------------------------------- shuttle and bolts
function followServer() {
  const s = game.server;
  S.x = s.x + s.face * 12;
  S.y = s.y - 30 + dsin(game.time * 4) * 1.5;
}
// does a shuttle moving from px to (x, y) hit the net? Anything crossing below the tape does, right down to the
// floor: the mesh ends at NET_BOTTOM but the post goes on down, and nothing may pass under the net
const hitsNet = (px, x, y) => (px - NET_X) * (x - NET_X) <= 0 && px !== x && y > NET_TOP;
function updateShuttle(dt) {
  if (S.state === "serve") return followServer();
  if (S.state !== "fly") return;
  const n = 4, h = dt / n;
  for (let i = 0; i < n; i++) {
    const v = dhypot(S.vx, S.vy);
    S.vx += -SH_K * v * S.vx * h;
    S.vy += (SH_G - SH_K * v * S.vy) * h;
    const px = S.x;
    S.x += S.vx * h;
    S.y += S.vy * h;
    // the net: anything under the tape bounces back off it
    if (hitsNet(px, S.x, S.y)) {
      S.x = px;
      S.vx = -S.vx * 0.15;
      S.vy = Math.max(S.vy, 0) * 0.4;
      S.smash = 0;
      say("NET!", C("#d8dcef"), 0.6, 44);
    }
    if (S.y >= FLOOR) return land();
  }
  S.smash = Math.max(0, S.smash - dt * 1.2);
  S.trail.push({ x: S.x, y: S.y });
  if (S.trail.length > 8) S.trail.shift();
}
function land() {
  S.y = FLOOR;
  S.state = "dead";
  S.trail = [];
  const inside = S.x >= COURT_L && S.x <= COURT_R;
  const winner = inside ? (S.x < NET_X ? P2 : P1) : S.last === P1 ? P2 : P1;
  winner.score++;
  marks.push({ x: S.x, t: 0, inside });
  puff(S.x, FLOOR, 5, 0, "#d8d0c0");
  say(inside ? "IN!" : "OUT!", inside ? C("#9dff9a") : C("#ff8a7a"), 1.2, 44);
  game.state = "point";
  game.timer = 1.4;
  game.pointWinner = winner;
}
function updateBolts(dt) {
  for (const b of bolts) {
    b.x += b.vx * dt;
    b.life -= dt;
    const o = other(b.owner);
    if (canBeHit(o) && circleBox(b.x, b.y, 5, hurtbox(o))) {
      b.life = 0;
      stunPlayer(o, "zap", b.owner);
      spawn(zapHit, { x: o.x - Math.sign(b.vx) * 4, y: b.y, flip: b.vx < 0, palette: PAL.volt }, { stopAt: 0.4 });
      hitstop(0.06);
      shake(2, 0.12);
    }
  }
  for (let i = bolts.length - 1; i >= 0; i--) if (bolts[i].life <= 0 || bolts[i].x < -20 || bolts[i].x > W + 20) bolts.splice(i, 1);
}

// ---------------------------------------------------------------- step
// ---------------------------------------------------------------- AI opponent (plays 2P)
// It presses 2P's keys through its own input source, like a third keyboard, so it follows every rule a person
// does (cooldowns, stuns, the serve line). It reads the shuttle with the same physics the game runs.
const AI_SRC = { held: new Set(), pressed: new Set() };
const AI_LEVELS = {
  easy: { name: "EASY", react: 0.4, aimErr: 22, miss: 0.25, smash: 0.12, zap: 0.05, dash: false, dodge: 0.15, serveWait: [1.4, 2.2] },
  normal: { name: "NORMAL", react: 0.2, aimErr: 9, miss: 0.08, smash: 0.45, zap: 0.15, dash: true, dodge: 0.5, serveWait: [0.9, 1.6] },
  hard: { name: "HARD", react: 0.07, aimErr: 3, miss: 0, smash: 0.85, zap: 0.3, dash: true, dodge: 0.9, serveWait: [0.5, 1.0] },
  // smart: plays every shot out (smash or each ground shot) and picks the one hardest to return, never hits it
  // out or into the net, and times its zaps to stun the other player just before they must hit (not now and then).
  // taunt: gloats after every point it wins, and on and on after winning the game (see tauntStep)
  extreme: { name: "EXTREME", react: 0, aimErr: 0, miss: 0, smash: 1, zap: 0, dash: true, dodge: 1, serveWait: [0.35, 0.6], smart: true, taunt: true },
  // Korean: Extreme, 15% quicker (pow, see above), and it plans further. plan: of every point on the shuttle's way
  // it can get to, it meets it at the one where its best shot is hardest to return (not just the first).
  // guard: while its shot is on the way, it waits where it can best reach every return they could play.
  // dash8: it makes the most of Quick Attack going any of 8 ways (see startQuick): it dashes up or across into the
  // air to smash a shuttle out of a jump's reach, and down to get back to the floor in a hurry.
  korean: { name: "KOREAN", react: 0, aimErr: 0, miss: 0, smash: 1, zap: 0, dash: true, dodge: 1, serveWait: [0.3, 0.5], smart: true, taunt: true, pow: 1.15, plan: true, guard: true, dash8: true, blockSmash: true },
};
const ai = { on: false, level: "normal", plan: null, lastBy: null, reactAt: 0, replanAt: 0, err: 0, skip: false, wantSmash: false, shotKeys: [], shotUntil: 0, serveAt: 0, guard: null, guardAt: 0, airDash: null, dodged: new Set() };
const tagOf = (p) => (ai.on && p === P2 ? "CPU" : `${p.id}P`);
const rand = (a, b) => a + Math.random() * (b - a);

function setAI(level) {
  ai.on = !!level;
  if (level) ai.level = level;
  P2.spr = ai.on ? SPR_CPU : SPR_P2;
  AI_SRC.held.clear();
  AI_SRC.pressed.clear();
  if (ai.on) (P1.ctl = ANY), (P1.src = LOCAL), (P2.ctl = CONTROLS[2]), (P2.src = AI_SRC);
  else if (net.mode === "local") (P1.ctl = CONTROLS[1]), (P2.ctl = CONTROLS[2]), (P1.src = P2.src = LOCAL);
}

// where the shuttle (or one starting from `from`) will be, frame by frame, until it lands (same integrator and
// net as updateShuttle)
function predictShuttle(maxT = 2.5, from = S) {
  const out = [], h = DT / 4;
  let { x, y, vx, vy } = from;
  for (let t = DT; t <= maxT; t += DT) {
    for (let k = 0; k < 4; k++) {
      const v = dhypot(vx, vy);
      vx += -SH_K * v * vx * h;
      vy += (SH_G - SH_K * v * vy) * h;
      const px = x;
      x += vx * h;
      y += vy * h;
      if (hitsNet(px, x, y)) (x = px), (vx = -vx * 0.15), (vy = Math.max(vy, 0) * 0.4);
      if (y >= FLOOR) return out.push({ t, x, y: FLOOR, vy, land: true }), out;
    }
    out.push({ t, x, y, vy });
  }
  return out;
}

// pick the point to meet the shuttle: a jump smash if it comes high enough (and we feel like it), else a ground hit.
// It only jumps for a smash that lands in even if the swing meets the shuttle a little late; a smart AI only
// when that is harder to return than the best shot it could play from the ground.
function aiPlan(me) {
  const path = predictShuttle(), mine = (s) => (me === P2 ? s.x > NET_X + 8 : s.x < NET_X - 8), L = AI_LEVELS[ai.level], op = other(me);
  const run = RUN * pow(me), dash = L.dash && me.cd.quick <= 0 ? QUICK.speed * QUICK.dur * pow(me) : 0;
  const reach = (s) => Math.abs(s.x - me.face * 12 - me.x) <= run * s.t + dash + 14;
  const smashIn = (i) => path.slice(i, i + 7).every((q) => tailIn(me, q));
  let low = path.find((s) => mine(s) && s.vy > 0 && s.y > FLOOR - 32 && reach(s)) ?? path.find((s) => mine(s) && s.vy > 0 && s.y > FLOOR - 32);
  if (L.plan && low) {
    // of the ground meet points it can surely get to (no slack, a moment to spare, not right at the floor), the one
    // whose best shot leaves them the least time; a later one only if clearly better, as earlier is safer
    const sure = (s) => Math.abs(s.x - me.face * 12 - me.x) <= run * (s.t - 0.06) + dash;
    let bestSpare = Infinity;
    for (let i = 0; i < path.length; i += 2) {
      const s = path[i];
      if (!(mine(s) && s.vy > 0 && s.y > FLOOR - 32 && s.y < FLOOR - 6 && (s === low || sure(s)))) continue;
      const shots = shotOptions(me, op, s);
      if (!shots.length) continue;
      const spare = Math.min(...shots.map((o) => o.spare));
      if (spare < bestSpare - 0.03) (bestSpare = spare), (low = s);
    }
  }
  if (ai.wantSmash && !L.smart) {
    const high = path.find((s, i) => mine(s) && s.vy > 0 && s.y > FLOOR - 82 && s.y < FLOOR - 52 && reach(s) && smashIn(i));
    if (high) return { ...high, smash: true };
  } else if (ai.wantSmash) {
    // the smash (meeting it anywhere it is in jump reach) leaving them the least time, if that beats the ground
    let best = null, bestSpare = Infinity;
    path.forEach((s, i) => {
      if (!(mine(s) && s.vy > 0 && s.y > FLOOR - 82 && s.y < FLOOR - 52 && reach(s) && smashIn(i))) return;
      const spare = spareTime(op, shotPath(me, s, "tail"));
      if (spare < bestSpare) (best = s), (bestSpare = spare);
    });
    const ground = low ? shotOptions(me, op, low).map((o) => o.spare) : [];
    if (best && (!ground.length || bestSpare < Math.min(...ground))) return { ...best, smash: true };
  }
  return low ? { ...low, smash: false } : null;
}

// a player's court is their own half (1P left, 2P right) wherever they stand: in a rally they may cross the net,
// but a shuttle landing on a side still scores for the other player
const inCourtOf = (p, x) => (p === P1 ? x < NET_X : x > NET_X);
// does a shuttle on this path come down inside op's court (with a little room off the lines)?
function landsIn(path, op) {
  const end = path.at(-1);
  return !!end?.land && end.x > COURT_L + 8 && end.x < COURT_R - 8 && inCourtOf(op, end.x);
}
// the shuttle's path after me hits it at s, with this kind of hit and direction held
const shotPath = (me, s, kind, dir = "") => predictShuttle(3, { x: s.x, y: s.y, ...shotVel(me.face, s.x, s.y, kind, dir) });
// would an Iron Tail meeting the shuttle at s land in? (close under the net it has to go up, and flies out)
const tailIn = (me, s) => landsIn(shotPath(me, s, "tail"), other(me));
// how long op would have to spare at their best chance to meet a shuttle on this path (< 0: they can't):
// the time until it gets there, less the time to run (or Quick Attack) to where their swing reaches it
function spareTime(op, path) {
  const theirs = (s) => inCourtOf(op, s.x), dash = op.cd.quick <= 0 ? QUICK.speed * QUICK.dur : 0;
  let best = -Infinity;
  for (const s of path) {
    if (!theirs(s) || s.y < FLOOR - 80) continue; // above a jump's reach
    const run = Math.max(0, Math.abs(s.x - op.face * 12 - op.x) - 14);
    best = Math.max(best, s.t - Math.min(run / RUN, Math.max(0, run - dash) / RUN + (dash ? QUICK.dur : 0)));
  }
  return best;
}
// can a zap, fired once the swing is over, stun op in the last moment before they must meet a shuttle on this path?
// (the stun outlasts that moment: only a jump over the bolt saves them)
function zapInTime(me, op, path) {
  const busy = BASIC.dur - BASIC.on, meet = path.find((s) => inCourtOf(op, s.x) && s.y > FLOOR - 40);
  return me.cd.zap <= busy && !!meet && meet.t - busy - zapTravel(me, op) > 0.05;
}
const zapTravel = (me, op) => ZAP.fire + Math.max(0, Math.abs(op.x - me.x) - 30) / ZAP.speed;
// the ground shots from s that land in, each with the time it leaves op to spare (a timed zap's stun counted in)
const shotOptions = (me, op, s) =>
  ["", "fwd", "back", "down"].map((dir) => ({ dir, path: shotPath(me, s, "basic", dir) })).filter((o) => landsIn(o.path, op))
    .map((o) => ({ dir: o.dir, spare: spareTime(op, o.path) - (zapInTime(me, op, o.path) ? STUN.zap : 0) }));
// of the ground shots that land in (played out from where the swing will meet the shuttle, a frame from now),
// the direction to hold for the one hardest to return: one leaving them the least time to spare (any within a
// tenth of a second of the best, so it doesn't always play the same shot)
function killerShot(shots) {
  if (!shots.length) return null;
  const best = Math.min(...shots.map((o) => o.spare)), near = shots.filter((o) => o.spare <= best + 0.1);
  return near[(Math.random() * near.length) | 0].dir;
}

// dash8: a dash, then the swing the moment it ends (in the air it's an Iron Tail), that meets the shuttle. For each of
// the 8 ways, where we'd be frame by frame (as updatePlayer moves us, holding nothing after the dash) against where
// the shuttle will be, while the swing can hit; of those that smash it in, the one leaving them the least time.
// Returns { keys, spare } or null.
// (frames until a dash ends, counted as updatePlayer counts them down: float steps make it 10, not 9)
const DASH_FRAMES = (() => { let q = QUICK.dur, f = 0; while (q > 0) (q -= DT), f++; return f; })();
const DASH_WAYS = [["right"], ["left"], ["up"], ["down"], ["up", "right"], ["up", "left"], ["down", "right"], ["down", "left"]];
function airDashSmash(me, op, path) {
  const sp = QUICK.speed * pow(me), frames = DASH_FRAMES, reach = BASIC.reachS * pow(me) * 0.9;
  let best = null;
  for (const keys of DASH_WAYS) {
    const dirX = keys.includes("right") ? 1 : keys.includes("left") ? -1 : 0, ny = keys.includes("up") ? -1 : keys.includes("down") ? 1 : 0;
    if (ny > 0 && me.ground) continue; // (down from the floor is just a forward dash)
    const n = dirX && ny ? Math.SQRT1_2 : 1;
    let x = me.x, y = me.y, vx = dirX * n * sp, vy = ny * n * sp;
    for (let f = 1; f < path.length && f <= frames + 1 + 10; f++) {
      if (f === frames) vy = ny * n * DASH8.keep;
      if (f > frames) (vx = 0), (vy += GRAV * DT); // the swing's frames: we hold nothing
      x = clamp(x + vx * DT, 12, W - 12);
      y = Math.max(24, y + vy * DT);
      if (y >= FLOOR) break; // back on the floor: no smash
      // the swing is pressed the frame after the dash ends and can hit from BASIC.on to BASIC.off into it. On frame f
      // the swing has run (f - frames) frames and, as players move before the shuttle, meets it where it was after
      // f - 1 of its steps (path[0] is after one)
      const a = (f - frames) * DT;
      if (a < BASIC.on || a > BASIC.off) continue;
      const s = path[f - 2];
      if (!s || !(me === P2 ? s.x > NET_X + 8 : s.x < NET_X - 8) || Math.hypot(s.x - (x + me.face * 12), s.y - (y - 18)) >= reach) continue;
      const shot = shotPath(me, s, "tail");
      if (landsIn(shot, op)) {
        const spare = spareTime(op, shot);
        if (!best || spare < best.spare) best = { keys, spare };
      }
      break; // the swing hits it here, whatever happens to it
    }
  }
  return best;
}

// guard: while our shot is on its way to op, where to wait. Of the ground returns op could play from where they
// will meet it (that land in), the spot that leaves us the most time to spare for the worst of them (nearest home
// among equals). null when there's nothing to go on.
function guardSpot(me, op, home) {
  const meet = predictShuttle().find((s) => inCourtOf(op, s.x) && s.vy > 0 && s.y > FLOOR - 40);
  if (!meet) return null;
  const returns = ["", "fwd", "back", "down"].map((dir) => shotPath(op, meet, "basic", dir)).filter((p) => landsIn(p, me));
  if (!returns.length) return null;
  const run = RUN * pow(me), lo = me === P2 ? NET_X + 10 : 12, hi = me === P2 ? W - 12 : NET_X - 10;
  let best = null, bestWorst = -Infinity;
  for (let x = lo; x <= hi; x += 6) {
    let worst = Infinity;
    for (const path of returns) {
      let spare = -Infinity;
      for (const s of path) if (inCourtOf(me, s.x) && s.y > FLOOR - 36) spare = Math.max(spare, meet.t + s.t - Math.abs(s.x - me.face * 12 - x) / run);
      worst = Math.min(worst, spare);
    }
    if (worst > bestWorst + 0.01 || (worst > bestWorst - 0.01 && Math.abs(x - home) < Math.abs(best - home))) (bestWorst = Math.max(worst, bestWorst)), (best = x);
  }
  return best;
}

// Extreme or Korean, having won a point: gloat. Taunts: rushing over the net to whack the loser (Quick Attack, then the
// swing), squash spam, and wiggling side to side while squashed. After a point it picks one and the next serve
// waits for it to finish; on the game-over screen it goes on, one after another (walking right up beside them
// first, as there's time), until a new game starts.
const TAUNTS = [["rush", 2.6], ["squats", 1.6], ["wiggle", 1.6]];
function tauntStep(me, op, now, hold, press) {
  if (!ai.taunt) {
    const i = (Math.random() * TAUNTS.length) | 0;
    ai.taunt = { i, until: now + TAUNTS[i][1] };
    if (game.state === "point") game.timer = Math.max(game.timer, TAUNTS[i][1]);
  }
  const t = ai.taunt, over = game.state === "over";
  if (over && now >= t.until) (t.i = (t.i + 1) % TAUNTS.length), (t.until = now + TAUNTS[t.i][1]);
  const kind = TAUNTS[t.i][0], dx = op.x - me.x, toward = dx > 0 ? "right" : "left";
  if (kind === "rush") {
    if (Math.abs(dx) > 20) {
      hold(toward);
      if (Math.abs(dx) > 40 && me.cd.quick <= 0) press("quick");
    } else if (!me.act) press("basic");
  } else if (over && Math.abs(dx) > (kind === "squats" ? 30 : 44)) hold(toward);
  else if (kind === "squats") Math.floor(now / 0.14) % 2 === 0 && hold("down");
  else (hold("down"), hold(Math.floor(now / 0.22) % 2 ? "left" : "right"));
}

// BASIC becomes active on its second update, before that frame’s shuttle movement.
// If a fast smash enters range on that frame, start an in-bounds ground reply now.
function earlySmashBlock(me, op) {
  if (S.last !== op || S.smash <= 0 || !me.ground || me.act || me.quickT > 0 || me.noHit > 0) return null;
  const reach = BASIC.reachS * pow(me) * 0.95;
  const hx = me.x + me.face * 12, hy = me.y - 18;
  if (dhypot(S.x - hx, S.y - hy) < reach) return null; // Normal swing already covers it.
  const [next] = predictShuttle(1.5 * DT);
  if (!next || next.land || !inCourtOf(me, next.x)) return null;
  const swingMove = 2 * DT * RUN * 0.55 * pow(me);
  if (dhypot(next.x - hx, next.y - hy) >= reach + swingMove) return null;
  return killerShot(shotOptions(me, op, next).filter(({ dir }) => {
    const dx = dir === "fwd" ? me.face : dir === "back" ? -me.face : 0;
    const swingX = clamp(me.x + dx * swingMove, 12, W - 12) + me.face * 12;
    return dhypot(next.x - swingX, next.y - hy) < reach;
  }));
}

function aiStep() {
  const me = P2, op = P1, L = AI_LEVELS[ai.level], k = me.ctl, now = game.time;
  const held = AI_SRC.held, press = (a) => AI_SRC.pressed.add(k[a][0]), hold = (a) => held.add(k[a][0]);
  AI_SRC.pressed.clear();
  held.clear();
  if (!gloating(me)) ai.taunt = null;
  else return void (me.stun <= 0 && !me.knocked && !game.paused && tauntStep(me, op, now, hold, press));
  if (game.state === "title" || game.state === "over" || game.paused || me.stun > 0 || me.knocked) return;
  const fwd = me.face > 0 ? "right" : "left", back = me.face > 0 ? "left" : "right";
  const home = me === P2 ? 290 : 94;

  // a shot is out: keep its direction key down until the swing is over
  if (now < ai.shotUntil) ai.shotKeys.forEach(hold);
  // the shot: only one that lands in their court (from deep in ours a drop falls short into the net, and close
  // under the net a drive goes into it), the smart one the hardest to return, the others by habit
  const chooseShot = (serve) => {
    const r = Math.random(), opNearNet = Math.abs(op.x - NET_X) < 60, opDeep = Math.abs(op.x - NET_X) > 130;
    const shots = shotOptions(me, op, S.state === "fly" ? (predictShuttle(1.5 * DT)[0] ?? S) : S), ok = shots.map((o) => o.dir);
    let dir = L.smart ? killerShot(shots) : null;
    if (dir === null) {
      dir = serve ? (r < 0.6 ? "" : r < 0.8 ? "back" : "down")
        : opNearNet ? (r < 0.6 ? "" : "back")
        : opDeep ? (r < 0.5 ? "down" : r < 0.8 ? "fwd" : "")
        : ["", "fwd", "back", "down"][(r * 4) | 0];
      if (ok.length && !ok.includes(dir)) dir = ok[(Math.random() * ok.length) | 0];
    }
    ai.shotKeys = { "": [], fwd: [fwd], back: [back], down: ["down"] }[dir];
    ai.shotUntil = now + 0.22;
  };

  // serving: wait a moment, then hit it
  if (game.state === "serve") {
    ai.plan = null;
    ai.lastBy = null;
    if (game.server !== me) return void (Math.abs(home - me.x) > 4 && hold(home > me.x ? "right" : "left"));
    if (!ai.serveAt) ai.serveAt = now + rand(...L.serveWait);
    if (now >= ai.serveAt && !me.act) (chooseShot(true), ai.shotKeys.forEach(hold), press("basic"), (ai.serveAt = 0));
    return;
  }
  ai.serveAt = 0;
  if (S.state !== "fly") return void (Math.abs(home - me.x) > 4 && hold(home > me.x ? "right" : "left"));

  // someone just hit it: take a moment to react, then decide how to meet it
  if (S.last !== ai.lastBy) {
    ai.lastBy = S.last;
    ai.plan = null;
    ai.reactAt = now + (S.last === op ? L.react : 0);
    ai.err = rand(-L.aimErr, L.aimErr);
    ai.skip = S.last === op && Math.random() < L.miss;
    ai.wantSmash = Math.random() < L.smash;
    ai.guardAt = 0;
    ai.airDash = null;
  }
  let target = home;
  // guard: our shot is on its way, so wait where their return is easiest to get to
  if (L.guard && S.last === me) {
    if (now >= ai.guardAt) (ai.guard = guardSpot(me, op, home)), (ai.guardAt = now + 0.15);
    if (ai.guard !== null) target = ai.guard;
  }
  if (S.last === op && now >= ai.reactAt) {
    if (!ai.plan || now >= ai.replanAt) (ai.plan = aiPlan(me)), (ai.plan && (ai.plan.at = now)), (ai.replanAt = now + 0.15);
    if (ai.plan) target = clamp(ai.plan.x - me.face * 12 + ai.err, me === P2 ? NET_X + 10 : 12, me === P2 ? W - 12 : NET_X - 10);
  }
  const dx = target - me.x, left = ai.plan ? ai.plan.t - (now - ai.plan.at) : 9;

  if (L.blockSmash && !ai.skip) {
    const block = earlySmashBlock(me, op);
    if (block !== null) {
      ai.shotKeys = { "": [], fwd: [fwd], back: [back], down: ["down"] }[block];
      ai.shotUntil = now + 0.22;
      held.clear();
      ai.shotKeys.forEach(hold);
      press("basic");
      return;
    }
  }

  // dash8: mid air-dash smash. Hold nothing while it flies, swing the moment it ends.
  if (ai.airDash) {
    if (me.act || now > ai.airDash.until || me.ground && me.quickT <= 0) ai.airDash = null;
    else return void (me.quickT <= 0 && press("basic"));
  }
  // dash8: an air-dash smash that is harder to return than what we had planned (or the only way to get it)
  if (L.dash8 && S.last === op && now >= ai.reactAt && !ai.skip && me.cd.quick <= 0 && me.quickT <= 0 && !me.act && Math.abs(S.x - me.x) < 160) {
    if (ai.plan && ai.plan.spare === undefined)
      ai.plan.spare = ai.plan.smash ? spareTime(op, shotPath(me, ai.plan, "tail")) : Math.min(Infinity, ...shotOptions(me, op, ai.plan).map((o) => o.spare));
    const dash = airDashSmash(me, op, predictShuttle(0.6));
    if (dash && (!ai.plan || dash.spare < ai.plan.spare - 0.05)) {
      held.clear();
      dash.keys.forEach(hold);
      press("quick");
      ai.airDash = { until: now + QUICK.dur + BASIC.off + 0.1 };
      return;
    }
  }

  // (it stands still while a shot's direction is held, so walking doesn't turn it into another shot)
  if (Math.abs(dx) > 3 && now >= ai.shotUntil) hold(dx > 0 ? "right" : "left");
  // far and running out of time: Quick Attack towards it (dash8, in the air: down and across, back to the floor)
  if (L.dash && ai.plan && Math.abs(dx) > 55 && left < Math.abs(dx) / (RUN * pow(me)) && me.cd.quick <= 0 && me.quickT <= 0)
    (L.dash8 && !me.ground && !ai.plan.smash && hold("down"), press("quick"));
  // a high one: jump so the swing meets it at the top (the swing then becomes Iron Tail)
  if (ai.plan?.smash && me.ground && Math.abs(dx) < 16 && left < 0.32 && left > 0.12) press("up");

  // swing when the shuttle is in reach
  // (in the air the swing is an Iron Tail: a smart AI holds it rather than smash the shuttle out)
  const hx = me.x + me.face * 12, hy = me.y - 18, tailOk = me.ground || !L.smart || tailIn(me, predictShuttle(1.5 * DT)[0] ?? S);
  if (!ai.skip && !me.act && S.last !== me && Math.hypot(S.x - hx, S.y - hy) < BASIC.reachS * pow(me) * 0.95 && tailOk) {
    if (me.ground) chooseShot(false);
    else (ai.shotKeys = []), (ai.shotUntil = 0);
    held.clear();
    ai.shotKeys.forEach(hold);
    press("basic");
  }

  // zap the other player now and then, when nothing more urgent is going on
  if (me.cd.zap <= 0 && !me.act && me.ground && op.ground && Math.abs(op.x - me.x) > 50 && left > 0.8 && Math.random() < L.zap * DT) press("zap");
  // smart: once our shot is on its way, send a bolt to stun them in the last moment before they must hit it
  // (the stun outlasts that moment, so only a jump over the bolt saves them)
  if (L.smart && S.last === me && me.cd.zap <= 0 && !me.act && me.ground && op.ground && canBeHit(op) && op.stun <= 0) {
    const meet = predictShuttle().find((s) => inCourtOf(op, s.x) && s.y > FLOOR - 40);
    const lead = meet && meet.t - zapTravel(me, op);
    if (lead > 0.05 && lead < 0.4) press("zap");
  }
  // a bolt coming our way: hop over it
  for (const b of bolts) {
    if (b.owner === me || ai.dodged.has(b.seed)) continue;
    const gap = (me.x - b.x) * Math.sign(b.vx);
    if (gap > 0 && gap < 70 && me.ground) {
      ai.dodged.add(b.seed);
      if (Math.random() < L.dodge) press("up");
    }
  }
  if (ai.dodged.size > 50) ai.dodged.clear();
}

// One frame of the game itself: everything in the state (saveState), nothing that is only for show. Online it may
// run again for a frame already played (see rollback.js), so it must give the same result from the same state and
// keys in any browser: no Math.random (srand), and detmath.js for sin, cos, atan2 and hypot.
// Returns true when the world moved (not paused or in a hit-stop).
function simStep(dt) {
  if (game.hold) return false; // debug: freeze the world for screenshots
  game.time += dt;
  if (anyPressed(PAUSE_KEYS) && (game.state === "serve" || game.state === "rally" || game.state === "point")) game.paused = !game.paused;
  if (game.paused) return false;
  if ((game.state === "title" || game.state === "over") && anyPressed(START_KEYS)) newGame();

  if (game.msg && (game.msg.t += dt) > game.msg.dur) game.msg = null;
  game.shakeT = Math.max(0, game.shakeT - dt);
  if (game.freeze > 0) {
    game.freeze -= dt;
    return false;
  }

  if (ai.on) aiStep();
  for (const p of PLAYERS) updatePlayer(p, dt);
  updateShuttle(dt);
  updateBolts(dt);
  for (const m of marks) m.t += dt;
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i].t > 1.6) marks.splice(i, 1);

  if (game.state === "point" && (game.timer -= dt) <= 0) {
    const w = game.pointWinner;
    if (w.score >= WIN) {
      game.state = "over";
      game.winner = w;
      say(`${w.id}P WINS!`, w.tag, 1e9, 70);
    } else resetRally(w);
  }
  return true;
}
// effects and dust: they move with the world (and freeze with it in a hit-stop)
function showStep(dt) {
  for (const e of effects) {
    if (e.follow) {
      e.fx.options.x = Math.round(e.follow.x);
      e.fx.options.y = Math.round(e.follow.y);
      if (!e.keepFlip) e.fx.options.flip = e.follow.face > 0;
    }
    e.fx.update(dt);
    if (e.stopAt && e.fx.t >= e.stopAt && !e.stopped) (e.fx.stop(), (e.stopped = true));
  }
  for (let i = effects.length - 1; i >= 0; i--) if (effects[i].fx.done()) effects.splice(i, 1);
  for (const d of dust) ((d.life += dt), (d.x += d.vx * dt), (d.y += d.vy * dt), (d.vx *= 1 - 4 * dt), (d.vy += 40 * dt));
  for (let i = dust.length - 1; i >= 0; i--) if (dust[i].life >= dust[i].max) dust.splice(i, 1);
}
// one whole frame, as played on one device
function step(dt) {
  if (simStep(dt)) showStep(dt);
  syncStatus();
}

// ---------------------------------------------------------------- drawing
const frame = createFrame(W, H);
const BG = (() => {
  const f = createFrame(W, H), p = painterFor(f);
  const wall = ["#0f0d1c", "#13112a", "#181538", "#1d1942", "#221d4a"].map(C);
  for (let y = 0; y < FLOOR; y++) p.rect(0, y, W, 1, wall[Math.min(4, Math.floor((y / FLOOR) * 5))]);
  // ceiling lamps and a kickboard
  for (let x = 24; x < W; x += 72) (p.rect(x, 0, 24, 3, C("#3c3768")), p.rect(x + 2, 3, 20, 1, C("#5c5694")));
  p.rect(0, FLOOR - 26, W, 2, C("#2a2456"));
  p.rect(0, FLOOR - 24, W, 24, C("#171430"));
  for (let x = 0; x < W; x += 32) p.rect(x, FLOOR - 24, 1, 24, C("#1e1a3c"));
  // floor: wood outside the court, green court, white lines
  for (let y = FLOOR; y < H; y++) {
    const band = Math.floor((y - FLOOR) / 4);
    p.rect(0, y, W, 1, C(band % 2 ? "#5e4127" : "#6a4a2c"));
    p.rect(COURT_L, y, COURT_R - COURT_L, 1, C(band % 2 ? "#226a45" : "#277550"));
  }
  for (let y = FLOOR; y < H; y += 4) for (let x = (y / 4) % 2 ? 0 : 20; x < W; x += 40) if (x < COURT_L || x > COURT_R) p.rect(x, y, 1, 4, C("#4e351f"));
  p.rect(COURT_L, FLOOR, COURT_R - COURT_L + 1, 1, C("#e8ecf4"));
  for (const x of [COURT_L, COURT_R, NET_X - SERVICE_LINE, NET_X + SERVICE_LINE]) p.rect(x, FLOOR, 1, H - FLOOR, C(x === COURT_L || x === COURT_R ? "#e8ecf4" : "#9fc8b0"));
  return f.color.slice();
})();

function drawNet(p) {
  p.place(0, 0);
  p.rect(NET_X, NET_TOP - 2, 1, FLOOR - NET_TOP + 2, C("#5a5f7a"));
  for (let y = NET_TOP + 2; y < NET_BOTTOM; y++) for (let x = NET_X - 2; x <= NET_X + 2; x++) if ((x + y) % 2 === 0) p.dot(x, y, C("#cfd4ea"), 0.7);
  p.rect(NET_X - 2, NET_TOP, 5, 2, C("#ffffff"));
  p.rect(NET_X - 2, NET_BOTTOM, 5, 1, C("#9aa0bc"));
}

// the hand-drawn squash frame for this much squash (none below a sliver; halfway, then flat)
const squashFrame = (spr, amount) => (amount < 0.12 || !spr.squash.length ? null : spr.squash[amount < 0.6 ? 0 : spr.squash.length - 1]);

function drawPlayer(p, P) {
  const spr = p.spr;
  let flip = p.face > 0, pal = spr.pal, ox = 0, oy = 0, tint;
  const a = p.act;
  if (a?.type === "tail") {
    if (a.t < TAIL.on) ox = -p.face * 2;
    else if (a.t < TAIL.off + 0.08) {
      flip = !flip; // spun round: the tail leads
      pal = { ...pal, ...STEEL };
      ox = p.face * 2;
    } else pal = { ...pal, ...STEEL };
  }
  if (a?.type === "basic" && a.t >= BASIC.on && a.t < BASIC.off) ox = p.face * 2;
  if (a?.type === "zap") pal = { ...pal, ...CHEEK_ZAP };
  if (p.ground && Math.abs(p.vx) > 5 && !a && p.stun <= 0) oy = Math.floor(game.time * 12) % 2 ? -1 : 0;
  if (p.stunKind === "basic" && p.stun > 0) tint = Math.floor(game.time * 30) % 2 ? WHITE : undefined;
  const blinkOff = p.iframes > 0 && Math.floor(game.time * 20) % 2 === 1;

  // after-images: solid silhouettes stepping from hot yellow to dim amber, oldest first, every other one
  for (let i = 0; i < p.trail.length; i += 2) {
    const g = p.trail[i], step = g.a > 0.55 ? 0 : g.a > 0.3 ? 1 : 2;
    P.place(Math.round(g.x), Math.round(g.y), g.flip);
    P.sprite(spr.rows, pal, spr.ax, spr.ay, { tint: AFTER[p.id][step] });
  }
  if (p.quickT > 0) {
    // speed lines trailing straight back from the dash, whichever way it goes
    P.place(0, 0);
    const cx = p.x, cy = p.y - 14, ux = -p.dashX, uy = -p.dashY;
    for (let i = -1; i <= 1; i++) {
      const len = 8 + ((i * 7 + 9 + Math.floor(game.time * 60)) % 9);
      for (let k = 14; k < 14 + len; k += 2) P.rect(Math.round(cx + ux * k - uy * i * 7), Math.round(cy + uy * k + ux * i * 7), 1, 1, C("#fff6c8"), 0.8);
    }
  }
  P.place(Math.round(p.x + ox), Math.round(p.y + oy), flip);
  const pose = squashFrame(spr, p.squash) ?? spr;
  if (!blinkOff) P.sprite(pose.rows, pal, pose.ax, pose.ay, { tint });

  // cheeks spark while charging a zap
  if (a?.type === "zap") {
    P.place(Math.round(p.x), Math.round(p.y), false);
    P.glow(0, -12, 14, VOLT[5], 0.6);
  }
  // the basic swing: a quick white crescent in front
  if (a?.type === "basic" && a.t >= BASIC.on - 0.02 && a.t < BASIC.off + 0.04) {
    const u = clamp((a.t - BASIC.on + 0.02) / (BASIC.off - BASIC.on + 0.06));
    P.place(Math.round(p.x), Math.round(p.y), p.face < 0);
    const a0 = -1.4 + u * 0.6, a1 = a0 + 1.6 + u * 0.6;
    P.arc(4, -18, 15, (v) => 3 * Math.sin(Math.PI * v), a0, a1, (uu) => (uu > 0.7 ? WHITE : C("#fff3b0")), 1 - u * 0.7);
    P.glow(12, -18, 12, C("#fff3b0"), 0.25 * (1 - u));
  }
  // steel glint while the tail is out
  if (a?.type === "tail" && a.t >= TAIL.on && a.t < TAIL.off) {
    P.place(Math.round(p.x), Math.round(p.y), p.face < 0);
    P.glow(14, -14, 14, C("#dfe8ff"), 0.35);
  }
  // player tag (online: mark which one is you)
  P.place(0, 0);
  const top = pose.ay; // shorter while squashed
  P.text(tagOf(p), Math.round(p.x), Math.round(p.y + top - 9), p.tag, { align: "center", outline: INK });
  if (net.mode !== "local" && p.id === myId()) P.text("YOU", Math.round(p.x), Math.round(p.y + top - 16), WHITE, { align: "center", outline: INK });
}

function drawShuttle(P) {
  P.place(0, 0);
  if (S.state === "fly") {
    S.trail.forEach((t, i) => {
      const k = i / S.trail.length;
      if (S.smash > 0.05) (P.dot(t.x, t.y, VOLT[5], k * S.smash), P.light(t.x, t.y, VOLT[4], 0.5 * k * S.smash));
      else if (Math.hypot(S.vx, S.vy) > 220) P.dot(t.x, t.y, C("#cfd6ff"), k * 0.5);
    });
  }
  // shadow on the floor
  if (S.state !== "dead") P.rect(Math.round(S.x) - 1, FLOOR + 1, 3, 1, C("#0a0812"), 0.6);
  // cork leads, feathers trail behind
  const v = Math.hypot(S.vx, S.vy);
  const dx = S.state === "fly" && v > 20 ? S.vx / v : 0, dy = S.state === "fly" && v > 20 ? S.vy / v : 1;
  const nx = -dy, ny = dx;
  for (let k = 1; k <= 6; k++) {
    const cx = S.x - dx * k, cy = S.y - dy * k, hw = 0.4 + k * 0.45;
    for (let s = -hw; s <= hw; s += 0.5) P.dot(cx + nx * s, cy + ny * s, k === 6 || Math.abs(s) > hw - 0.5 ? C("#a8b0c8") : C("#f2f4fa"));
  }
  P.dot(S.x, S.y, C("#ffffff"));
  P.dot(S.x + dx, S.y + dy, C("#e0c79a"));
  if (S.smash > 0.05) P.glow(S.x, S.y, 10, VOLT[5], 0.5 * S.smash);
  // off the top of the screen: an arrow
  if (S.y < 2) {
    const x = Math.round(clamp(S.x, 4, W - 4));
    P.tri(x, 2, x - 3, 7, x + 3, 7, C("#ffffff"));
  }
}

function drawBolt(P, b) {
  P.place(0, 0);
  const d = Math.sign(b.vx), f = Math.floor(game.time * 30);
  const path = zigzag(rng(b.seed, f >> 1), b.x - d * 16, b.y, b.x + d * 2, b.y, 0.45, 0.3);
  crackle(P, path, 0.95, VOLT, 0.55);
  P.disc ? P.disc(b.x, b.y, 2.5, VOLT[6], 1) : P.circle(b.x, b.y, 2, VOLT[6]);
  P.dot(b.x, b.y, WHITE);
  P.glow(b.x, b.y, 12, VOLT[5], 0.5);
}

function drawHud(P) {
  P.place(0, 0);
  P.text(`${P1.score}`, NET_X - 18, 10, P1.tag, { font: "big", scale: 2, align: "center", outline: INK });
  P.text("-", NET_X, 14, C("#c8c4dc"), { font: "big", align: "center", outline: INK });
  P.text(`${P2.score}`, NET_X + 18, 10, P2.tag, { font: "big", scale: 2, align: "center", outline: INK });
  const skills = [["ZAP", "zap", ZAP.cd], ["DASH", "quick", QUICK.cd]];
  for (const p of PLAYERS) {
    const left = p === P1, x0 = left ? 8 : W - 8 - skills.length * 30 + 6;
    P.text(tagOf(p), left ? 8 : W - 8, 9, p.tag, { font: "big", align: left ? "left" : "right", outline: INK });
    skills.forEach(([label, key, cd], i) => {
      const locked = key === "zap" && game.state === "serve"; // zaps unlock once the serve is hit
      const x = x0 + i * 30, y = 20, ready = p.cd[key] <= 0 && !locked, k = locked ? 0 : 1 - p.cd[key] / cd;
      P.text(label, x, y, ready ? C("#fff3a0") : C("#6c6888"), { outline: INK });
      P.rect(x, y + 7, 24, 2, C("#2a2648"));
      P.rect(x, y + 7, Math.round(24 * k), 2, ready ? VOLT[5] : C("#8a86a8"));
    });
  }
  if (game.state === "serve") {
    const s = game.server;
    // light up the server's service line on the floor so it's clear where the serve must come from
    const lx = s === P1 ? NET_X - SERVICE_LINE : NET_X + SERVICE_LINE, glow = 0.55 + 0.45 * Math.sin(game.time * 6);
    P.rect(lx, FLOOR, 1, H - FLOOR, VOLT[6], glow);
    P.rect(lx, FLOOR - 1, 1, 1, VOLT[6], glow);
    P.glow(lx, FLOOR + 6, 10, VOLT[4], 0.35 * glow);
    if (Math.floor(game.time * 3) % 2) P.text("HIT TO SERVE", Math.round(s.x), Math.round(s.y + s.spr.ay - 22), C("#ffffff"), { align: "center", outline: INK });
  }
  for (const m of marks) {
    const a = clamp(1.6 - m.t);
    P.rect(Math.round(m.x) - 2, FLOOR, 5, 1, m.inside ? C("#9dff9a") : C("#ff8a7a"), a);
  }
  if (game.msg) {
    const m = game.msg, pop = m.t < 0.08 ? 3 : 2;
    P.text(m.text, W / 2, m.y - (pop - 2) * 3, m.color, { font: "big", scale: pop, align: "center", outline: INK });
  }
}

function drawOverlay(P) {
  P.place(0, 0);
  if (game.state === "title") {
    P.rect(W / 2 - 112, 36, 224, 122, INK);
    P.rect(W / 2 - 112, 36, 224, 1, VOLT[4]);
    P.rect(W / 2 - 112, 157, 224, 1, VOLT[4]);
    P.text("PIKA", W / 2, 46, VOLT[5], { font: "big", scale: 4, align: "center", outline: INK });
    P.text("BADMINTON", W / 2, 80, C("#ffffff"), { font: "big", scale: 3, align: "center", outline: INK });
    P.glow(W / 2, 70, 90, VOLT[4], 0.15);
    if (Math.floor(game.time * 2) % 2) P.text("PRESS ENTER", W / 2, 128, C("#fff3a0"), { font: "big", align: "center", outline: INK });
    P.text(`FIRST TO ${WIN}`, W / 2, 144, C("#9a96b0"), { align: "center", outline: INK });
    if (ai.on) P.text(`VS CPU - ${AI_LEVELS[ai.level].name}`, W / 2, 168, C("#cfd8ea"), { align: "center", outline: INK });
    if (net.mode !== "local") P.text(`ONLINE - YOU ARE ${myId()}P`, W / 2, 168, C("#ffffff"), { align: "center", outline: INK });
  } else if (game.state === "over") {
    P.rect(W / 2 - 90, 58, 180, 70, INK);
    if (Math.floor(game.time * 2) % 2) P.text("PRESS ENTER", W / 2, 110, C("#fff3a0"), { font: "big", align: "center", outline: INK });
  }
  if (game.paused) {
    P.rect(W / 2 - 60, 82, 120, 34, INK);
    P.text("PAUSED", W / 2, 92, C("#ffffff"), { font: "big", scale: 2, align: "center", outline: INK });
  }
  // online: the other side has gone quiet (their tab is hidden, or the connection stalled) and the game waits
  if (net.rb?.waiting(performance.now(), 400)) {
    P.rect(W / 2 - 50, 120, 100, 15, INK);
    if (Math.floor(performance.now() / 400) % 2) P.text(net.mode === "guest" ? "WAITING FOR 1P..." : "WAITING FOR 2P...", W / 2, 124, C("#fff3a0"), { align: "center", outline: INK });
  }
}

function render() {
  clearFrame(frame);
  let P = painterFor(frame);
  for (const e of effects) e.fx.draw(frame, "back");
  P = painterFor(frame);
  drawNet(P);
  for (const d of dust) P.dot(d.x, d.y, d.c, 1 - d.life / d.max);
  for (const p of PLAYERS) drawPlayer(p, P);
  drawShuttle(P);
  for (const b of bolts) drawBolt(P, b);
  for (const e of effects) e.fx.draw(frame, "front");
  P = painterFor(frame);
  drawHud(P);
  drawOverlay(P);
}

// ---------------------------------------------------------------- online (PeerJS: browser-to-browser WebRTC)
// Rollback netcode (rollback.js). Both browsers run the whole game, and only key presses travel between them.
// Each side plays its own keys at once (or a frame or two later on a slow link) and guesses the other player's
// (the keys they held last); when the real ones arrive and differ, it rewinds to that frame and plays forward
// again, all before the next screen is drawn. Nobody waits for the network to see their own Pikachu move or
// their own swing land, and both screens show the same game, neither one behind the other.
// PeerJS sets up the connection and its reliable "ctl" channel, which carries the room's few messages (ready,
// start, resync, NAT). The game's packets go on a second channel of the same connection that we open ourselves
// ("negotiated", so PeerJS is not involved): unordered and never retransmitted, so a lost packet never holds up
// the ones behind it. Each packet repeats every input the other side has not confirmed yet instead.
const ROOM_PREFIX = "pika-badminton-v2-"; // v2: rollback (a v1 page and a v2 page cannot play each other)
const GAME_CHANNEL = { negotiated: true, id: 42, ordered: false, maxRetransmits: 0 };
const net = { mode: "local", peer: null, ctl: null, game: null, gameReady: false, peerReady: false, viaCtl: false, rb: null, code: null, resyncAt: 0, pingShown: 0 };
const myId = () => (net.mode === "guest" ? 2 : 1);
const sendCtl = (msg) => net.ctl?.open && net.ctl.send(msg);
// for testing: "?delay=0" fixes the input delay (frames); "?netsim=lag:40,jitter:20,loss:0.05,spikes:0.01" makes
// this side's game packets late (ms), uneven, lost, and now and then (spikes: the chance per packet) 100-250 ms late
const QUERY = new URLSearchParams(location.search);
const FIXED_DELAY = QUERY.has("delay") ? Math.max(0, Math.min(8, Number(QUERY.get("delay")) | 0)) : undefined;
const NETSIM = QUERY.has("netsim") ? { lag: 0, jitter: 0, loss: 0, spikes: 0, ...Object.fromEntries(QUERY.get("netsim").split(",").map((kv) => kv.split(":")).map(([k, v]) => [k, Number(v) || 0])) } : null;

function setMode(mode) {
  net.mode = mode;
  if (mode === "local") (P1.ctl = CONTROLS[1]), (P2.ctl = CONTROLS[2]), (P1.src = P2.src = LOCAL);
  else (P1.ctl = P2.ctl = CONTROLS[1]), (P1.src = NET_SRC[0]), (P2.src = NET_SRC[1]);
  // the AI only plays offline: going online sends it home, coming back brings it back if it was on
  if (mode !== "local") (P2.spr = SPR_P2), (ai.wasOn = ai.wasOn || ai.on), (ai.on = false);
  else if (ai.wasOn) (ai.wasOn = false), setAI(ai.level);
  ui.sync();
}
function toTitle() {
  effects.length = 0;
  statusFx.clear();
  bolts.length = 0;
  dust.length = 0;
  marks.length = 0;
  P1.score = P2.score = 0;
  resetRally(P1);
  game.state = "title";
  game.msg = null;
  game.paused = false;
}
function makeCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => A[(Math.random() * A.length) | 0]).join("");
}
function leave(silent) {
  try { net.game?.close(); net.ctl?.close(); net.peer?.destroy(); } catch {}
  stopSession();
  Object.assign(net, { peer: null, ctl: null, game: null, gameReady: false, peerReady: false, viaCtl: false, code: null, route: null, peerNat: null, connText: null });
  const wasOnline = net.mode !== "local";
  setMode("local");
  if (wasOnline) toTitle();
  if (!silent) ui.status("한 키보드로 둘이 하는 로컬 모드예요.");
}
function onDisconnect() {
  if (net.mode === "local" && !net.peer) return;
  leave(true);
  ui.status("연결이 끊겼어요. 로컬 모드로 돌아왔어요.", "warn");
}
function onCtl(d) {
  if (d.t === "ready") {
    net.peerReady = true;
    if (d.viaCtl) net.viaCtl = true; // their game channel never opened: send over ctl too, or they would not hear us
    maybeStart();
  } else if (d.t === "start" && net.mode === "guest" && !net.rb) startSession(d.seed);
  else if (d.t === "resync" && net.mode === "guest") net.rb?.resync(d.f, d.s, d.gen);
  else if (d.t === "g" && Array.isArray(d.d)) net.rb?.receive(new Uint8Array(d.d).buffer);
  else if (d.t === "nat") {
    net.peerNat = String(d.v).slice(0, 60);
    refreshConn();
  } else if (d.t === "full") {
    leave(true);
    ui.status("그 방은 이미 두 명이 차 있어요.", "warn");
  }
}

// ---- the game channel: opened on the ctl connection by both sides at once (same id), no signaling needed
function openGameChannel(conn) {
  let dc = null;
  try {
    dc = conn.peerConnection.createDataChannel("game", GAME_CHANNEL);
  } catch (err) {
    console.warn("[net] could not open the game channel:", err);
  }
  if (dc) {
    net.game = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => gameChannelReady(conn);
    dc.onmessage = (e) => net.ctl === conn && net.rb?.receive(e.data);
    if (dc.readyState === "open") gameChannelReady(conn);
  }
  // not open after 3 s: send the game over ctl instead (reliable and ordered, so worse when packets are lost)
  setTimeout(() => {
    if (net.ctl !== conn || net.gameReady) return;
    console.warn("[net] the game channel did not open; the game goes over ctl");
    net.viaCtl = true;
    gameChannelReady(conn);
  }, 3000);
}
function gameChannelReady(conn) {
  if (net.ctl !== conn || net.gameReady) return;
  net.gameReady = true;
  sendCtl({ t: "ready", viaCtl: net.viaCtl });
  maybeStart();
}
// the host starts the match once both channels are up: the same seed on both sides, from frame 0
function maybeStart() {
  if (net.mode !== "host" || net.rb || !net.gameReady || !net.peerReady) return;
  const seed = (Math.random() * 2 ** 32) >>> 0;
  sendCtl({ t: "start", seed });
  startSession(seed);
}
function sendGame(buf) {
  if (NETSIM) {
    const spike = Math.random() < NETSIM.spikes ? 100 + Math.random() * 150 : 0;
    if (Math.random() >= NETSIM.loss) workerTimeout(NETSIM.lag + Math.random() * NETSIM.jitter + spike, () => sendGameNow(buf));
  } else sendGameNow(buf);
}
function sendGameNow(buf) {
  if (net.viaCtl) return void sendCtl({ t: "g", d: Array.from(new Uint8Array(buf)) });
  // a packet repeats everything the last one had: if the link is backed up, skip it rather than queue it
  if (net.game?.readyState === "open" && net.game.bufferedAmount < 16384) net.game.send(buf);
}

// ---- the match: both sides start from the same state and seed at frame 0
function startSession(seed) {
  for (const p of PLAYERS) {
    const { ctl, src, spr, tag } = p;
    Object.assign(p, makePlayer(p.id), { ctl, src, spr, tag });
  }
  Object.assign(game, { state: "title", server: P1, timer: 0, msg: null, paused: false, winner: null, pointWinner: null, time: 0, freeze: 0, shakeT: 0, shakeA: 0, rng: seed >>> 0 });
  toTitle();
  held.clear();
  pressed.clear();
  fxLog.seen.clear();
  Object.assign(fxLog, { on: true, replay: false });
  net.rb = new Rollback({
    me: net.mode === "guest" ? 1 : 0,
    now: () => performance.now(),
    readInput: readLocalInput,
    step: playFrame,
    save: saveState,
    load: loadState,
    hash: hashState,
    send: sendGame,
    beforeReplay: fxBeforeReplay,
    afterReplay: fxAfterReplay,
    onDesync,
    delay: FIXED_DELAY,
  });
  console.info(`[net] match started (${net.mode}, seed ${seed})`);
}
function stopSession() {
  net.rb = null;
  fxLog.on = false;
  fxLog.seen.clear();
}
// one frame with both players' keys (replay: played again after a wrong guess; nothing new to show then)
function playFrame(a, b, frame, replay) {
  decodeInput(NET_SRC[0], a);
  decodeInput(NET_SRC[1], b);
  fxLog.frame = frame;
  fxLog.count.clear();
  const moved = simStep(DT);
  if (replay) return;
  if (moved) showStep(DT);
  syncStatus();
  if (frame % 60 === 0) fxForget(frame - 120);
}
// The two games disagreed (should never happen: same code, same keys, same math). The host's game counts: it
// sends its state, and the guest rewinds to it and plays on from there.
function onDesync(frame) {
  console.warn(`[net] desync found at frame ${frame}`);
  if (net.mode !== "host" || performance.now() - net.resyncAt < 1000) return;
  const fin = net.rb.finalState();
  if (!fin) return;
  net.resyncAt = performance.now();
  sendCtl({ t: "resync", gen: net.rb.bumpGen(), f: fin.f, s: fin.s });
}

// ---- the game state: everything simStep reads and changes, as plain data (players as ids)
const PLAYER_KEYS = ["x", "y", "vx", "vy", "face", "ground", "quickT", "dashX", "dashY", "stun", "stunKind", "stunN", "knocked", "knockT", "iframes", "noHit", "score", "squash"];
const byId = (id) => (id === 1 ? P1 : id === 2 ? P2 : null), idOf = (p) => p?.id ?? 0;
function saveState() {
  return {
    p: PLAYERS.map((p) => {
      const o = { act: p.act && { ...p.act }, cd: { ...p.cd }, trail: p.trail.map((g) => ({ ...g })) };
      for (const k of PLAYER_KEYS) o[k] = p[k];
      return o;
    }),
    s: { x: S.x, y: S.y, vx: S.vx, vy: S.vy, state: S.state, last: idOf(S.last), smash: S.smash, trail: S.trail.map((t) => ({ ...t })) },
    g: {
      state: game.state, server: idOf(game.server), timer: game.timer, msg: game.msg && { ...game.msg }, paused: game.paused, winner: idOf(game.winner),
      pointWinner: idOf(game.pointWinner), time: game.time, freeze: game.freeze, shakeT: game.shakeT, shakeA: game.shakeA, rng: game.rng,
    },
    b: bolts.map((b) => ({ ...b, owner: b.owner.id })),
    m: marks.map((m) => ({ ...m })),
  };
}
function loadState(st) {
  st.p.forEach((o, i) => {
    const p = PLAYERS[i];
    for (const k of PLAYER_KEYS) p[k] = o[k];
    p.act = o.act && { ...o.act };
    p.cd = { ...o.cd };
    p.trail = o.trail.map((g) => ({ ...g }));
  });
  const s = st.s, g = st.g;
  Object.assign(S, { x: s.x, y: s.y, vx: s.vx, vy: s.vy, state: s.state, last: byId(s.last), smash: s.smash, trail: s.trail.map((t) => ({ ...t })) });
  Object.assign(game, {
    state: g.state, server: byId(g.server), timer: g.timer, msg: g.msg && { ...g.msg }, paused: g.paused, winner: byId(g.winner),
    pointWinner: byId(g.pointWinner), time: g.time, freeze: g.freeze, shakeT: g.shakeT, shakeA: g.shakeA, rng: g.rng,
  });
  bolts.length = 0;
  for (const b of st.b) bolts.push({ ...b, owner: byId(b.owner) });
  marks.length = 0;
  for (const m of st.m) marks.push({ ...m });
}
// 32-bit hash of a saved state, from the exact bits of every number (-0 counts as 0)
const hashF64 = new Float64Array(1), hashU32 = new Uint32Array(hashF64.buffer);
function hashState(st) {
  let h = 0x811c9dc5;
  const mix = (w) => {
    h = Math.imul(h ^ w, 0x01000193);
    h ^= h >>> 15;
  };
  const walk = (v) => {
    if (typeof v === "number") (hashF64[0] = v + 0), mix(hashU32[0]), mix(hashU32[1]);
    else if (typeof v === "string") {
      mix(v.length);
      for (let i = 0; i < v.length; i++) mix(v.charCodeAt(i));
    } else if (typeof v === "boolean") mix(v ? 3 : 2);
    else if (v == null) mix(1);
    else if (Array.isArray(v)) (mix(v.length), v.forEach(walk));
    else for (const k of Object.keys(v).sort()) if (v[k] !== undefined) (walk(k), walk(v[k]));
  };
  walk(st);
  return h >>> 0;
}

// ICE servers: Google STUN always (free: it only tells each browser its public address), plus Cloudflare TURN
// relays fetched from our own /api/turn function (api/turn.js on Vercel). The browser tries a direct connection
// first, then STUN, and only relays through TURN when both fail, so TURN traffic is used only when it must be.
// Add "?relay=1" to the address to force TURN, which is how to test the relay path.
const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
let turnCache = { servers: null, until: 0 };
async function turnServers() {
  if (turnCache.servers && performance.now() < turnCache.until) return turnCache.servers;
  try {
    const r = await fetch("/api/turn", { signal: AbortSignal.timeout(4000), cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { iceServers } = await r.json();
    turnCache = { servers: iceServers, until: performance.now() + 5 * 3600e3 }; // credentials last 6 h
    return iceServers;
  } catch (err) {
    console.info("[net] no TURN relay available (STUN only):", err.message ?? err);
    return [];
  }
}
async function peerOptions() {
  const relayOnly = new URLSearchParams(location.search).has("relay");
  const turn = await turnServers();
  net.hasTurn = turn.length > 0;
  return { debug: 1, config: { iceServers: [...STUN_SERVERS, ...turn], ...(relayOnly ? { iceTransportPolicy: "relay" } : {}) } };
}
// once connected: which route did ICE pick? (shown next to the status so you can tell when TURN is in use)
async function routeOf(conn) {
  try {
    const stats = await conn.peerConnection.getStats();
    let pair = null;
    stats.forEach((s) => s.type === "transport" && s.selectedCandidatePairId && (pair = stats.get(s.selectedCandidatePairId)));
    if (!pair) stats.forEach((s) => s.type === "candidate-pair" && s.state === "succeeded" && s.nominated && (pair = s));
    const types = [stats.get(pair?.localCandidateId)?.candidateType, stats.get(pair?.remoteCandidateId)?.candidateType];
    if (types.includes("relay")) return "TURN 중계";
    if (types.includes("srflx") || types.includes("prflx")) return "인터넷 직접 연결(STUN)";
    if (types.includes("host")) return "같은 네트워크 직접 연결";
  } catch {}
  return "알 수 없음";
}
// ICE starts on whichever pair answers first (often TURN, which is ready early) and may move to a better one
// a few seconds later, so the route is checked again for a while instead of only once.
async function showRoute(conn, text, code) {
  Object.assign(net, { route: null, myNat: null, peerNat: null, connText: text, connCode: code });
  refreshConn(conn);
  for (const wait of [0, 2000, 5000, 10000, 20000]) {
    setTimeout(async () => {
      if (net.ctl !== conn || !conn.open) return;
      const route = await routeOf(conn);
      if (net.route && net.route !== route) console.info(`[net] route changed: ${net.route} -> ${route}`);
      net.route = route;
      refreshConn(conn);
    }, wait);
  }
  natType().then((nat) => {
    net.myNat = nat;
    sendCtl({ t: "nat", v: nat }); // so both sides can see both NATs
    refreshConn(conn);
  });
}
function refreshConn(conn = net.ctl) {
  if (!conn || net.ctl !== conn || !conn.open || !net.connText) return;
  const other = net.mode === "guest" ? "방장" : "친구";
  ui.status(
    `${net.connText} · 연결 방식: ${net.route ?? "확인 중…"} · 내 NAT: ${net.myNat ?? "확인 중…"} · ${other} NAT: ${net.peerNat ?? "확인 중…"}`,
    "ok",
    net.connCode
  );
}

// ---- NAT check. Ask several STUN servers at different addresses for our public address from one socket.
// Same public port from all: the router keeps one mapping for every destination ("일반형"), so the two
// browsers can usually reach each other directly through STUN. Different ports: a symmetric NAT ("대칭형")
// gives each destination its own port, so the address learned from STUN is useless to the friend → TURN.
// (Some networks block UDP 3478, so two Google servers on 19302 are asked as well as Cloudflare.)
const NAT_PROBE = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"];
let natCache = null;
function natType() {
  natCache ??= (async () => {
    try {
      const pc = new RTCPeerConnection({ iceServers: NAT_PROBE.map((urls) => ({ urls })) });
      const ports = new Map(); // public ip -> Set of public ports
      const answered = new Set(); // which STUN servers replied (when the browser says)
      let srflx = 0, finish;
      const done = new Promise((r) => (finish = r));
      pc.onicecandidate = (e) => {
        const c = e.candidate;
        if (!c) return finish();
        if (c.type !== "srflx") return;
        srflx++;
        const f = c.candidate.split(" "), ip = c.address ?? f[4], port = Number(c.port ?? f[5]);
        if (!ports.has(ip)) ports.set(ip, new Set());
        ports.get(ip).add(port);
        const url = e.url || c.url;
        if (url) answered.add(url);
        if (answered.size >= 2 || [...ports.values()].some((s) => s.size > 1)) finish(); // enough to decide
      };
      pc.createDataChannel("nat");
      await pc.setLocalDescription(await pc.createOffer());
      await Promise.race([done, new Promise((r) => setTimeout(r, 10000))]);
      pc.close();
      if (!srflx) return "확인 불가(STUN 응답 없음 · UDP 차단 가능성)";
      if ([...ports.values()].some((s) => s.size > 1)) return "대칭형(STUN 직접 연결 어려움)";
      if (answered.size >= 2 || srflx >= 2) return "일반형(STUN 직접 연결 가능)";
      return "확인 불가(STUN 서버 한 곳만 응답)";
    } catch (err) {
      return `확인 불가(${err.name ?? err})`;
    }
  })();
  return natCache;
}

// The usual cause on a Mac: the browser lacks macOS's Local Network permission, so it cannot resolve the other
// side's ".local" (mDNS) address and silently drops every candidate it receives.
const NET_HINT = "맥이라면 시스템 설정 → 개인정보 보호 및 보안 → 로컬 네트워크에서 브라우저가 켜져 있는지 확인해 주세요(켠 뒤 브라우저를 완전히 껐다 켜기).";

// the PeerJS signaling server (0.peerjs.com) has to answer before anything else can happen
function signalingTimeout(peer) {
  setTimeout(() => {
    if (net.peer !== peer || peer.open) return;
    console.warn("[net] signaling server did not answer");
    leave(true);
    ui.status("PeerJS 서버(0.peerjs.com)에 10초 동안 접속하지 못했어요. 광고 차단 확장 프로그램이나 네트워크를 확인해 주세요.", "warn");
  }, 10000);
}

// ---- connection diagnostics: which stage we reached and which ICE candidates were tried
async function iceReport(conn) {
  const pc = conn?.peerConnection;
  if (!pc) return "WebRTC 연결이 만들어지지 않았어요";
  const local = new Set(), remote = new Set();
  let pairs = 0, ok = 0;
  try {
    (await pc.getStats()).forEach((s) => {
      if (s.type === "local-candidate") local.add(s.candidateType);
      if (s.type === "remote-candidate") remote.add(s.candidateType);
      if (s.type === "candidate-pair") (pairs++, s.state === "succeeded" && ok++);
    });
  } catch {}
  const list = (set) => [...set].join("/") || "없음";
  const d = conn._diag ?? { sent: [], recv: [], errors: [] };
  const kinds = (arr) => (arr.length ? `${arr.length}개(${[...new Set(arr)].join(",")})` : "0개");
  return (
    `ICE ${pc.iceConnectionState} · 내 후보 ${list(local)} · 상대 후보 ${list(remote)} · 후보 쌍 ${pairs}개 중 성공 ${ok}개` +
    ` · 보낸 후보 ${kinds(d.sent)} · 받은 후보 ${kinds(d.recv)}` +
    (d.errors.length ? ` · 후보 추가 오류 ${d.errors.length}번: ${d.errors[0]}` : "") +
    ` · signaling ${pc.signalingState} · 상대 SDP ${pc.remoteDescription?.type ?? "없음"} · ${browserName()}`
  );
}
// Google Chrome on a Mac (not an iPad posing as a Mac, and not Edge / Opera / Whale / Vivaldi / Brave / other
// Chromium). Those get a "made for Safari" note: on recent macOS, Chrome's local-network permission often
// does not apply to the copy of Chrome that actually runs, which breaks same-network online play.
function isMacChrome(ua = navigator.userAgent, brands = navigator.userAgentData?.brands, touch = navigator.maxTouchPoints) {
  if (!/Macintosh|Mac OS X/.test(ua) || touch > 1) return false;
  if (brands?.length) return brands.some((b) => b.brand === "Google Chrome");
  return /Chrome\/\d/.test(ua) && !/Edg\/|OPR\/|Whale\/|Vivaldi|Electron|CriOS/.test(ua);
}
(() => {
  const note = document.getElementById("browser-note");
  if (!note) return;
  const force = new URLSearchParams(location.search).has("browsernote"); // to look at the note in any browser
  if (!force && !isMacChrome()) return;
  // shown on every visit; closing it only hides it until the page is opened again
  note.hidden = false;
  document.getElementById("browser-note-close").onclick = () => (note.hidden = true);
})();
const browserName = () => {
  const ua = navigator.userAgent;
  return /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? `Chrome ${ua.match(/Chrome\/(\d+)/)[1]}` : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "기타 브라우저";
};
// count ICE candidates going out and coming in, and catch addIceCandidate errors (PeerJS swallows them)
function instrument(conn) {
  const pc = conn.peerConnection;
  if (!pc || conn._diag) return;
  const d = (conn._diag = { sent: [], recv: [], errors: [] });
  const kind = (s) => {
    const typ = / typ (\w+)/.exec(s ?? "")?.[1] ?? "?";
    return typ === "host" && /\.local /.test(s) ? "host-mdns" : typ;
  };
  pc.addEventListener("icecandidate", (e) => e.candidate && d.sent.push(kind(e.candidate.candidate)));
  const add = pc.addIceCandidate.bind(pc);
  pc.addIceCandidate = async (c, ...rest) => {
    d.recv.push(kind(c?.candidate));
    try {
      return await add(c, ...rest);
    } catch (err) {
      d.errors.push(`${err.name}: ${err.message}`);
      console.warn("[net] addIceCandidate failed", err, c);
      throw err;
    }
  };
}
function watchConn(conn, who) {
  instrument(conn);
  const other = who === "guest" ? "방장과" : "친구와";
  conn.on("iceStateChanged", (s) => {
    console.info(`[net] ${who} ${conn.label} ICE ${s}`);
    if (!conn.open && conn.label === "ctl") ui.status(`${other} 연결을 맞추는 중… (ICE ${s})`, "", who === "host" ? net.code : null);
  });
  conn.on("error", async (err) => {
    const report = await iceReport(conn);
    console.warn(`[net] ${who} ${conn.label} error ${err.type}: ${report}`);
    if (conn.label === "ctl" && !net.ctl?.open) ui.status(`${other} 연결하지 못했어요 (${err.type}). ${NET_HINT} 진단: ${report} · TURN ${net.hasTurn ? "있음" : "없음"}`, "warn", who === "host" ? net.code : null);
  });
}

async function hostRoom() {
  if (typeof Peer === "undefined") return ui.status("PeerJS를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.", "warn");
  if (net.starting) return;
  leave(true);
  ui.status("연결 준비 중…");
  natType();
  net.starting = true;
  ui.sync();
  const options = await peerOptions().finally(() => (net.starting = false));
  const code = makeCode(), peer = new Peer(ROOM_PREFIX + code, options);
  Object.assign(net, { peer, code });
  ui.status("PeerJS 서버에 접속하는 중…");
  ui.sync();
  signalingTimeout(peer);
  peer.on("open", () => ui.status("친구에게 이 방 코드를 알려 주세요. 친구가 들어오길 기다리는 중…", "", code));
  peer.on("connection", (conn) => {
    watchConn(conn, "host");
    if (conn.label !== "ctl") return void conn.close(); // (the game itself runs on a channel of this connection)
    if (net.ctl?.open) return void conn.on("open", () => (conn.send({ t: "full" }), setTimeout(() => conn.close(), 300)));
    ui.status("친구가 들어오는 중…", "", code);
    net.ctl = conn;
    setTimeout(async () => {
      if (net.ctl !== conn || conn.open) return;
      const report = await iceReport(conn);
      console.warn(`[net] host: guest never connected: ${report}`);
      net.ctl = null;
      conn.close();
      ui.status(`친구와 20초 동안 연결되지 않았어요. 이 방 코드로 다시 들어올 수 있어요. ${NET_HINT} 진단: ${report} · TURN ${net.hasTurn ? "있음" : "없음"}`, "warn", code);
    }, 22000);
    conn.on("open", () => {
      setMode("host");
      toTitle();
      openGameChannel(conn);
      showRoute(conn, "친구와 연결됐어요! 나는 1P(방장)예요. Enter를 누르면 시작해요", code);
    });
    conn.on("data", onCtl);
    conn.on("close", onDisconnect);
  });
  peer.on("disconnected", () => !net.ctl?.open && ui.status("중계 서버와 연결이 끊겼어요. 다시 방을 만들어 주세요.", "warn"));
  peer.on("error", (err) => {
    if (err.type === "unavailable-id") return hostRoom();
    ui.status(`연결 오류 (${err.type}). 다시 시도해 주세요.`, "warn");
  });
}

// Room codes are typed with the keyboard in Korean mode as often as not: "ADNZN" arrives as "뭉ㅋ누".
// Turn every Hangul syllable or jamo back into the 2-beolsik keys that typed it, then keep A-Z and 0-9.
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ", JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const JAMO_KEYS = {
  ㄱ: "r", ㄲ: "r", ㄴ: "s", ㄷ: "e", ㄸ: "e", ㄹ: "f", ㅁ: "a", ㅂ: "q", ㅃ: "q", ㅅ: "t", ㅆ: "t", ㅇ: "d", ㅈ: "w", ㅉ: "w",
  ㅊ: "c", ㅋ: "z", ㅌ: "x", ㅍ: "v", ㅎ: "g", ㄳ: "rt", ㄵ: "sw", ㄶ: "sg", ㄺ: "fr", ㄻ: "fa", ㄼ: "fq", ㄽ: "ft", ㄾ: "fx", ㄿ: "fv", ㅀ: "fg", ㅄ: "qt",
  ㅏ: "k", ㅐ: "o", ㅑ: "i", ㅒ: "o", ㅓ: "j", ㅔ: "p", ㅕ: "u", ㅖ: "p", ㅗ: "h", ㅘ: "hk", ㅙ: "ho", ㅚ: "hl", ㅛ: "y",
  ㅜ: "n", ㅝ: "nj", ㅞ: "np", ㅟ: "nl", ㅠ: "b", ㅡ: "m", ㅢ: "ml", ㅣ: "l",
};
function roomCode(raw) {
  let out = "";
  for (const ch of raw) {
    const s = ch.charCodeAt(0) - 0xac00;
    if (s >= 0 && s < 11172) out += JAMO_KEYS[CHO[Math.floor(s / 588)]] + JAMO_KEYS[JUNG[Math.floor((s % 588) / 28)]] + (JAMO_KEYS[JONG[s % 28]] ?? "");
    else out += JAMO_KEYS[ch] ?? ch;
  }
  return out.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
}

async function joinRoom(raw) {
  if (typeof Peer === "undefined") return ui.status("PeerJS를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.", "warn");
  const code = roomCode(raw);
  if (!/^[A-Z0-9]{5}$/.test(code)) return ui.status("방 코드는 5글자예요.", "warn");
  if (net.starting) return;
  leave(true);
  ui.status("연결 준비 중…");
  natType();
  net.starting = true;
  ui.sync();
  const peer = new Peer(await peerOptions().finally(() => (net.starting = false)));
  Object.assign(net, { peer, code });
  ui.status("PeerJS 서버에 접속하는 중…");
  ui.sync();
  signalingTimeout(peer);
  peer.on("open", () => {
    ui.status("방장을 찾는 중…");
    const id = ROOM_PREFIX + code;
    const ctl = peer.connect(id, { label: "ctl", reliable: true, serialization: "json" });
    net.ctl = ctl;
    watchConn(ctl, "guest");
    // ICE can sit in "checking" for a long time without ever reporting failure: give up after 20 s and say why
    setTimeout(async () => {
      if (net.peer !== peer || ctl.open) return;
      const report = await iceReport(ctl);
      console.warn(`[net] guest timeout: ${report}`);
      leave(true);
      ui.status(`20초 동안 연결되지 않았어요. ${NET_HINT} 진단: ${report} · TURN ${net.hasTurn ? "있음" : "없음"}`, "warn");
    }, 20000);
    ctl.on("open", () => {
      held.clear();
      setMode("guest");
      toTitle();
      openGameChannel(ctl);
      showRoute(ctl, "연결됐어요! 나는 2P예요. 방장이나 내가 Enter를 누르면 시작해요", code);
    });
    ctl.on("data", onCtl);
    ctl.on("close", onDisconnect);
  });
  peer.on("error", (err) => {
    if (err.type === "peer-unavailable") (leave(true), ui.status("그 코드의 방을 찾을 수 없어요. 코드를 다시 확인해 주세요.", "warn"));
    else ui.status(`연결 오류 (${err.type}). 다시 시도해 주세요.`, "warn");
  });
}

// ---- touch controls (phones and tablets): on-screen buttons that press the 1P keys
// 1P keys work for both players online (each side may use either layout), so one set of buttons covers it.
const TOUCH = matchMedia("(pointer: coarse)").matches || new URLSearchParams(location.search).has("touch");
(() => {
  const pad = document.getElementById("pad");
  if (!TOUCH || !pad) return;
  document.body.classList.add("touch");
  pad.hidden = false;
  const down = new Map(); // pointerId -> the button it is holding
  const release = (id) => {
    const b = down.get(id);
    if (!b) return;
    down.delete(id);
    b.classList.remove("on");
    if (![...down.values()].includes(b)) keyUp(b.dataset.key);
  };
  const hold = (id, b) => {
    if (down.get(id) === b) return;
    release(id);
    down.set(id, b);
    b.classList.add("on");
    keyDown(b.dataset.key);
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8); // a light buzz on Android
  };
  for (const b of pad.querySelectorAll("[data-key]")) {
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // let a thumb slide from one button onto the next (throws for a pointer the browser no longer tracks)
      try {
        b.releasePointerCapture(e.pointerId);
      } catch {}
      hold(e.pointerId, b);
    });
    b.addEventListener("pointerenter", (e) => e.buttons && hold(e.pointerId, b));
    b.addEventListener("pointerleave", (e) => down.get(e.pointerId) === b && release(e.pointerId));
  }
  for (const ev of ["pointerup", "pointercancel"]) addEventListener(ev, (e) => release(e.pointerId));
  pad.addEventListener("contextmenu", (e) => e.preventDefault());
  // no zooming on a game page. iPhone Safari ignores user-scalable=no and sometimes touch-action, so:
  // swallow the second tap of a quick double tap (that is what zooms), except inside text fields
  let lastTap = 0;
  document.addEventListener("touchend", (e) => {
    const now = e.timeStamp;
    if (now - lastTap < 350 && !(e.target instanceof HTMLInputElement) && e.cancelable) e.preventDefault();
    lastTap = now;
  }, { passive: false });
  document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
  // and two-finger pinch (Safari's gesture events; other browsers obey the viewport tag)
  for (const ev of ["gesturestart", "gesturechange"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  // tap the game screen to start (there is no Enter key on a phone)
  document.getElementById("screen").addEventListener("pointerdown", () => {
    if (game.state === "title" || game.state === "over") (keyDown("Enter"), setTimeout(() => keyUp("Enter"), 60));
  });
  setupPlayMode();
})();

// ---- full-screen play: just the game and the buttons
// Ordinary tall phones play sideways (Android also locks landscape). Near-square screens (iPhone Duo, other
// foldables, tablets) are not locked: upright they get the handheld layout (game on top, controller below, see
// index.html), sideways the full-height one. iPhone Safari has no full screen for pages, so there we explain
// "Add to Home Screen" (the manifest then opens it without browser bars) and offer the same layout anyway.
const TALL_SCREEN = () => Math.max(screen.width, screen.height) / Math.min(screen.width, screen.height) > 5 / 3;
function setupPlayMode() {
  const $ = (id) => document.getElementById(id);
  const play = $("btn-play"), exit = $("btn-exit"), iosHelp = $("ios-help");
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const INSTALLED = matchMedia("(display-mode: fullscreen), (display-mode: standalone)").matches || navigator.standalone === true;
  const fsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement;
  let wake = null;
  const keepAwake = async () => {
    try {
      wake = await navigator.wakeLock?.request("screen"); // the screen must not dim mid-rally
    } catch {}
  };
  const setPlaying = (on) => {
    document.body.classList.toggle("playing", on);
    if (on) keepAwake();
    else wake?.release?.().catch(() => {}), (wake = null);
    scrollTo(0, 0);
  };
  function enter() {
    const el = document.documentElement;
    const request = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    const canFull = !INSTALLED && request && (document.fullscreenEnabled || document.webkitFullscreenEnabled);
    if (!canFull && IOS && !INSTALLED) return void (iosHelp.hidden = false);
    // switch the layout now; never wait on the full-screen promise (some browsers leave it pending)
    setPlaying(true);
    if (!canFull) return;
    Promise.resolve()
      .then(() => request({ navigationUI: "hide" }))
      .then(() => TALL_SCREEN() && screen.orientation?.lock?.("landscape")) // Android, once in full screen
      .catch(() => {});
  }
  function leavePlay() {
    if (fsElement()) (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
    screen.orientation?.unlock?.();
    setPlaying(false);
  }
  play.hidden = false;
  play.onclick = enter;
  exit.onclick = leavePlay;
  $("ios-ok").onclick = () => (iosHelp.hidden = true);
  $("ios-anyway").onclick = () => ((iosHelp.hidden = true), setPlaying(true));
  // the system "back"/Esc gesture can leave full screen on its own: follow it
  for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) document.addEventListener(ev, () => !fsElement() && document.body.classList.contains("playing") && !INSTALLED && setPlaying(false));
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && document.body.classList.contains("playing") && keepAwake());
  if (INSTALLED) play.textContent = "▶ 게임 화면으로 하기";
}

// ---- the online panel under the game
const ui = (() => {
  const $ = (id) => document.getElementById(id);
  const el = { host: $("btn-host"), join: $("btn-join"), leave: $("btn-leave"), code: $("room-input"), status: $("net-status"), room: $("room-code"), ping: $("net-ping") };
  if (!el.host) return { status() {}, sync() {}, ping() {} };
  el.host.onclick = () => hostRoom();
  el.join.onclick = () => joinRoom(el.code.value);
  // The field is read-only so no IME ever composes in it (the Korean IME would hold its own copy of the
  // text and fight every edit). Instead we read the physical key (e.code), which is the same in any layout.
  el.code.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.code === "Backspace") (e.preventDefault(), (el.code.value = ""));
      return; // let Cmd/Ctrl+V reach the paste handler
    }
    const m = /^(?:Key([A-Z])|Digit(\d)|Numpad(\d))$/.exec(e.code);
    if (m) (e.preventDefault(), (el.code.value = (el.code.value + (m[1] ?? m[2] ?? m[3])).slice(0, 5)));
    else if (e.code === "Backspace") (e.preventDefault(), (el.code.value = el.code.value.slice(0, -1)));
    else if (e.code === "Delete" || e.code === "Escape") (e.preventDefault(), (el.code.value = ""));
    else if (e.code === "Enter" || e.code === "NumpadEnter") (e.preventDefault(), joinRoom(el.code.value));
  });
  // pasting a code (even one copied as Hangul) works too
  const paste = (e) => {
    if (document.activeElement !== el.code || el.code.disabled) return;
    e.preventDefault();
    el.code.value = roomCode(e.clipboardData?.getData("text") ?? "");
  };
  document.addEventListener("paste", paste);
  el.leave.onclick = () => leave();
  // phones have no physical keys to read, so there the field takes ordinary typing; the code is converted
  // (Hangul → keys, uppercase) only when joining, never mid-typing
  if (TOUCH) {
    el.code.readOnly = false;
    el.code.setAttribute("autocapitalize", "characters");
    el.code.setAttribute("inputmode", "text");
    el.code.setAttribute("enterkeyhint", "go");
  }
  return {
    status(text, kind = "", code = null) {
      el.status.textContent = text;
      el.status.dataset.kind = kind;
      el.room.textContent = code ?? "";
      el.room.hidden = !code;
      if (!code) el.ping.textContent = "";
    },
    ping(ms, detail = "") {
      el.ping.textContent = `핑 ${ms}ms`;
      el.ping.title = detail;
    },
    sync() {
      const busy = !!net.peer || !!net.starting;
      el.leave.hidden = !busy;
      el.host.disabled = el.join.disabled = busy;
      el.code.disabled = busy;
      this.onMode?.();
    },
  };
})();

// ---- choosing the opponent: the AI at one of five levels, or two people on one device
(() => {
  const buttons = [...document.querySelectorAll("[data-ai]")], status = document.getElementById("mode-status");
  if (!buttons.length) return;
  const show = () => {
    const level = net.mode === "local" && ai.on ? ai.level : net.mode === "local" ? "" : null;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.ai === level));
    status.textContent =
      net.mode !== "local" ? "온라인 대전 중에는 고를 수 없어요."
      : ai.on ? `AI(${{ easy: "쉬움", normal: "보통", hard: "어려움", extreme: "극악", korean: "한국인" }[ai.level]})와 대전해요. 나는 1P예요. ${TOUCH ? "START나 화면을 누르면" : "Enter를 누르면"} 시작해요.`
      : "한 기기로 둘이서 해요. 1P와 2P 조작은 아래 표를 보세요.";
  };
  for (const b of buttons)
    b.onclick = () => {
      if (net.peer) leave(true); // leaving an online room to play here
      setAI(b.dataset.ai || null);
      toTitle();
      show();
      b.blur(); // so Enter/Space go to the game, not back to this button
    };
  // a phone has one player: start against the AI
  if (TOUCH) setAI("normal");
  show();
  ui.onMode = show; // online state changes refresh it too
})();

// ---------------------------------------------------------------- main loop
const canvas = document.getElementById("screen"), ctx = canvas.getContext("2d");
const img = new ImageData(W, H);
let last = performance.now(), acc = 0;
// advance the game to `now`; drawing happens only in frameLoop
function tick(now) {
  const elapsed = (now - last) / 1000;
  last = now;
  if (net.rb) {
    // online: rollback.js plays the frames (ours, theirs, and any replays) and exchanges the keys
    net.rb.tick(now);
    if (now - net.pingShown > 500 && net.rb.rtt !== null) {
      net.pingShown = now;
      const st = net.rb.stats;
      ui.ping(Math.round(net.rb.rtt), `입력 지연 ${net.rb.delay}프레임 · 되감기 ${st.replays}번(최대 ${st.maxReplay}프레임) · 기다림 ${st.waits}번 · 불일치 ${st.desyncs}번`);
    }
    return;
  }
  if (net.mode !== "local") return; // online, until both sides are ready to start
  acc = Math.min(acc + elapsed, 0.25);
  while (acc >= DT) {
    step(DT);
    pressed.clear();
    acc -= DT;
  }
}
// A hidden tab gets no animation frames, which would freeze an online game for both players.
// Timers inside a worker keep running in the background, so they keep it ticking.
const bgTicker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 16)"], { type: "text/javascript" })));
let lastFrame = performance.now();
bgTicker.onmessage = () => {
  const now = performance.now();
  if (net.mode !== "local" && now - lastFrame > 100) tick(now); // frames have stalled: tab hidden or covered
};
// setTimeout for the network simulator (?netsim): worker timers are not slowed down in a background tab
const workerTimeout = (() => {
  let worker = null, n = 0;
  const waiting = new Map();
  return (ms, fn) => {
    if (!worker) {
      worker = new Worker(URL.createObjectURL(new Blob(["onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms)"], { type: "text/javascript" })));
      worker.onmessage = (e) => (waiting.get(e.data)?.(), waiting.delete(e.data));
    }
    waiting.set(++n, fn);
    worker.postMessage({ id: n, ms });
  };
})();
function frameLoop(now) {
  requestAnimationFrame(frameLoop); // first, so that one bad frame cannot stop the game
  lastFrame = performance.now();
  tick(now);
  render();
  composite(frame, img.data, BG);
  const s = game.shakeT > 0 ? game.shakeA : 0;
  ctx.fillStyle = "#0b0a12";
  ctx.fillRect(0, 0, W, H);
  ctx.putImageData(img, Math.round((Math.random() - 0.5) * 2 * s), Math.round((Math.random() - 0.5) * 2 * s));
}
P1.x = 96;
P2.x = 288;
followServer();
requestAnimationFrame(frameLoop);

// debug handle for testing in the console
window.__pika = { game, P1, P2, S, effects, bolts, step, held, pressed, net, iceReport, natType, ai, setAI, toTitle, isMacChrome, saveState, loadState, hashState, keyDown, keyUp, tick: (t) => tick(t), renderOnce: () => (render(), composite(frame, img.data, BG)), paint: () => (render(), composite(frame, img.data, BG), ctx.putImageData(img, 0, 0)) };
