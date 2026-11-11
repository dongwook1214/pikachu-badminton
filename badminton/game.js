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

// ---------------------------------------------------------------- world
const W = 384, H = 216, FLOOR = 196, NET_X = 192, NET_TOP = 160, NET_BOTTOM = 184, COURT_L = 16, COURT_R = 368;
const GRAV = 900, JUMP_V = 330, RUN = 115;
const SH_G = 420, SH_K = 0.0028;              // shuttle gravity and quadratic drag (tuned in a sim)
const WIN = 11;
const SERVE_GAP = 12; // during the serve, how close to the net a player's center may get
const SQUASH = { y: 0.62, x: 1.22, rate: 16 }; // Down held: height and width at full squash, ease speed
const SERVICE_LINE = 56; // the short service lines sit this far either side of the net; the server stays behind theirs
const DT = 1 / 60;

// move timings (seconds)
const BASIC = { dur: 0.26, on: 0.03, off: 0.16, reachS: 21, reachP: 14 };
const TAIL = { dur: 0.5, on: 0.12, off: 0.3, cd: 1.6, reachS: 24, reachP: 19 };
const ZAP = { dur: 0.24, fire: 0.07, cd: 1.2, speed: 250 };
const QUICK = { dur: 0.15, speed: 470, up: 430, cd: 0.9 };
const STUN = { basic: 0.2, zap: 0.5, tail: 0.5 };

const C = (h) => hex(h);
const VOLT = fit(PAL.volt, 8);
const WHITE = C("#ffffff"), INK = C("#0b0a12");

// ---------------------------------------------------------------- sprites
// players: pikachu_grid.json (art/pikachu_pixel.py); the CPU opponent: cpu_grid.json (art/cpu_pixel.py, original)
// A sprite: trimmed rows, its palette, the offset that puts its feet at (0, 0), and a pixelfx actor (mask +
// pixels) for the effects that wrap a body (electrified, stunned). squash: hand-drawn frames for holding Down
// (halfway, then flat), each trimmed the same way; a sprite without them is squashed by resampling instead.
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
const ACTOR = SPR_P1.actor; // online play only uses the player sprite
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
const GAME_KEYS = new Set([...Object.values(ANY).flat(), "Enter", "Space", "Escape", "KeyP"]);
// input sources: this keyboard, and the friend's keyboard arriving over the network (host only)
const LOCAL = { held: new Set(), pressed: new Set() }, REMOTE = { held: new Set(), pressed: new Set() };
const held = LOCAL.held, pressed = LOCAL.pressed;
const typing = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
// one path for real keys and the touch buttons (which press the 1P keys for you)
function keyDown(code, repeat = false) {
  if (!repeat) pressed.add(code);
  held.add(code);
  if (net.mode === "guest" && !repeat && GAME_KEYS.has(code)) sendCtl({ t: "k", c: code, d: 1 });
}
function keyUp(code) {
  held.delete(code);
  if (net.mode === "guest" && GAME_KEYS.has(code)) sendCtl({ t: "k", c: code, d: 0 });
}
addEventListener("keydown", (e) => {
  if (typing(e)) return;
  if (GAME_KEYS.has(e.code)) e.preventDefault();
  keyDown(e.code, e.repeat);
});
addEventListener("keyup", (e) => keyUp(e.code));
addEventListener("blur", () => {
  held.clear();
  if (net.mode === "guest") sendCtl({ t: "rel" });
});
const pHeld = (p, codes) => codes.some((c) => p.src.held.has(c));
const pPressed = (p, codes) => codes.some((c) => p.src.pressed.has(c));
// menu keys (start, pause) count from either keyboard
const anyPressed = (codes) => codes.some((c) => LOCAL.pressed.has(c) || (net.mode === "host" && REMOTE.pressed.has(c)));

// ---------------------------------------------------------------- state
const makePlayer = (id) => ({
  id, ctl: CONTROLS[id], src: LOCAL, spr: id === 1 ? SPR_P1 : SPR_P2, tag: C(id === 1 ? "#ff6b5b" : "#5bb0ff"),
  x: 0, y: FLOOR, vx: 0, vy: 0, face: id === 1 ? 1 : -1, ground: true,
  act: null, cd: { zap: 0, tail: 0, quick: 0 }, quickT: 0, quickDir: null,
  stun: 0, stunKind: null, knocked: false, knockT: 0, iframes: 0, statusFx: null,
  trail: [], score: 0, squash: 0,
});
const P1 = makePlayer(1), P2 = makePlayer(2), PLAYERS = [P1, P2];
const other = (p) => (p === P1 ? P2 : P1);
const S = { x: 0, y: 0, vx: 0, vy: 0, state: "serve", last: null, smash: 0, trail: [] };

const game = { state: "title", server: P1, timer: 0, msg: null, paused: false, winner: null, time: 0, freeze: 0, shakeT: 0, shakeA: 0 };
const effects = [], bolts = [], dust = [], marks = [];

function resetRally(server) {
  net.p2Epoch++; // positions reset: 2P's own prediction must restart from here
  game.server = server;
  P1.x = 96; P2.x = 288;
  for (const p of PLAYERS) {
    Object.assign(p, { y: FLOOR, vx: 0, vy: 0, ground: true, act: null, quickT: 0, stun: 0, stunKind: null, knocked: false, iframes: 0, trail: [] });
    p.cd = { zap: 0, tail: 0, quick: 0 };
    p.face = p === P1 ? 1 : -1;
    clearStatus(p);
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
  effects.length = 0;
  game.winner = null;
  resetRally(Math.random() < 0.5 ? P1 : P2);
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
const MODS = { hitSpark, critHit, bluntHit, zapHit, electrified, spinSlash, stunnedFx };
const MOD_NAME = new Map(Object.entries(MODS).map(([k, v]) => [v, k]));
let fxId = 0;
function spawn(mod, opts, extra = {}) {
  const o = { seed: (Math.random() * 1e6) | 0, ...opts };
  const e = { fx: createFx(mod, o), id: ++fxId, ...extra };
  effects.push(e);
  // the friend's screen builds the same effect from the same seed
  if (net.mode === "host") sendCtl({ t: "fx", id: e.id, m: MOD_NAME.get(mod), o: { ...o, actor: o.actor ? 1 : 0 } });
  return e;
}
function puff(x, y, n, dir = 0, color = "#b8a890") {
  for (let i = 0; i < n; i++)
    dust.push({
      x: x + (Math.random() - 0.5) * 8, y: y - Math.random() * 2,
      vx: (dir || (Math.random() < 0.5 ? -1 : 1)) * (20 + Math.random() * 50), vy: -10 - Math.random() * 30,
      life: 0, max: 0.25 + Math.random() * 0.25, c: C(color), r: Math.random() < 0.4 ? 1 : 0,
    });
}
function clearStatus(p) {
  if (p.statusFx) {
    const i = effects.indexOf(p.statusFx);
    if (i >= 0) effects.splice(i, 1);
    p.statusFx = null;
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
  if (o === P2) net.p2Epoch++; // the host moves 2P now (knockback, stun): its prediction yields to the host
  o.act = null;
  o.quickT = 0;
  o.trail = [];
  clearStatus(o);
  o.stunKind = kind;
  if (kind === "basic") {
    o.stun = STUN.basic;
    o.vx = from.face * 170;
  } else if (kind === "zap") {
    o.stun = STUN.zap;
    o.vx = 0;
    if (!o.ground) o.vy = Math.max(o.vy, 0);
    o.statusFx = spawn(electrified, { x: o.x, y: o.y, actor: o.spr.actor, palette: PAL.volt, sparks: ["#ffffff", "#fff6c4", "#ffe066", "#f0b424"] }, { follow: o });
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

function hitShuttle(p, kind) {
  const c = p.ctl, fwd = pHeld(p, p.face > 0 ? c.right : c.left), back = pHeld(p, p.face > 0 ? c.left : c.right), down = pHeld(p, c.down);
  let sp, ang;
  if (kind === "tail") {
    sp = 560;
    ang = 20;
    const ahead = (NET_X - S.x) * p.face; // > 0 when the net is still in front of the shuttle
    if (ahead > 4) ang = Math.min(20, (Math.atan2(NET_TOP - 10 - S.y, ahead) * 180) / Math.PI - 3);
    ang = Math.max(ang, -40);
  } else {
    // clears, lobs and drives aim ~30 px inside the far baseline: speed fitted in a sim to distance and height
    const dist = p.face > 0 ? COURT_R - S.x : S.x - COURT_L, h = FLOOR - S.y;
    if (down) (sp = 220), (ang = -34);
    else if (fwd) (sp = clamp(40 + 1.607 * dist - 1.283 * h, 260, 560)), (ang = -22);
    else if (back) (sp = clamp(-217 + 3.302 * dist - 0.453 * h, 300, 640)), (ang = -68);
    else (sp = clamp(-7 + 1.714 * dist - 0.575 * h, 250, 560)), (ang = -52);
  }
  const r = (ang * Math.PI) / 180;
  S.vx = Math.cos(r) * sp * p.face;
  S.vy = Math.sin(r) * sp;
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
  if (type === "zap") p.cd.zap = ZAP.cd;
}
function startQuick(p, dirX) {
  p.cd.quick = QUICK.cd;
  p.act = null;
  p.quickT = QUICK.dur;
  if (pHeld(p, p.ctl.up)) {
    p.quickDir = "up";
    p.vy = -QUICK.up;
    p.ground = false;
    p.vx = dirX * RUN;
    puff(p.x, FLOOR, 5);
  } else {
    const d = dirX === -p.face ? -p.face : p.face;
    p.quickDir = d;
    p.vx = d * QUICK.speed;
    p.vy = 0;
    if (p.ground) puff(p.x, FLOOR, 6, -d);
  }
}

function updatePlayer(p, dt) {
  const o = other(p), c = p.ctl, dirX = (pHeld(p, c.right) ? 1 : 0) - (pHeld(p, c.left) ? 1 : 0);
  const rep = guestMove(p); // online host: 2P moves where the guest's own (predicted) game says it is
  for (const k in p.cd) p.cd[k] = Math.max(0, p.cd[k] - dt);
  p.iframes = Math.max(0, p.iframes - dt);

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
      clearStatus(p);
    }
  }

  if (free && game.state !== "title" && game.state !== "over") {
    if (rep) p.face = rep.f;
    else if (!p.act && p.quickT <= 0 && Math.abs(o.x - p.x) > 1) p.face = Math.sign(o.x - p.x);
    if (!rep && pPressed(p, c.quick) && p.cd.quick <= 0 && p.quickT <= 0) startQuick(p, dirX);
    else if (!p.act && p.quickT <= 0) {
      if (pPressed(p, c.zap) && p.cd.zap <= 0) startAct(p, "zap");
      else if (pPressed(p, c.basic)) startAct(p, "basic");
    }
    if (!rep && pPressed(p, c.up) && p.ground && p.quickT <= 0 && !(p.act && p.act.type === "tail")) {
      p.vy = -JUMP_V;
      p.ground = false;
      puff(p.x, FLOOR, 3);
    }
    if (rep) {
      // moved by the guest's report below
    } else if (p.quickT > 0) {
      p.quickT -= dt;
      if (p.quickDir === "up") p.vx = dirX * RUN * 1.2;
    } else {
      const k = p.act ? (p.act.type === "tail" ? (p.ground ? 0 : 0.5) : 0.55) : 1;
      p.vx = dirX * RUN * k;
    }
  }

  // physics (or, for an online 2P moving freely, just the position its own game reported)
  if (rep) {
    Object.assign(p, { x: rep.x, y: rep.y, vx: rep.vx, vy: rep.vy, ground: !!rep.g, quickT: rep.q, quickDir: rep.qd });
    p.cd.quick = rep.cq;
  } else {
    const dashing = p.quickT > 0 && p.quickDir !== "up";
    if (!dashing) p.vy += GRAV * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.y >= FLOOR) {
      if (!p.ground && p.vy > 260) puff(p.x, FLOOR, 4);
      p.y = FLOOR;
      p.vy = 0;
      p.ground = true;
    } else p.ground = false;
  }
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
    puff(p.x, FLOOR, 7);
    clearStatus(p);
    p.statusFx = spawn(stunnedFx, { x: p.x, y: p.y, actor: p.spr.actor }, { follow: p });
  }

  // hold Down on the ground to squash flat (eased in and out; just for show)
  const squashTo = p.ground && free && game.state !== "title" && game.state !== "over" && pHeld(p, c.down) ? 1 : 0;
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
    if (!a.hitS && canHitShuttle(p) && Math.hypot(S.x - hx, S.y - hy) < BASIC.reachS) {
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
      if (!a.hitS && canHitShuttle(p) && Math.hypot(S.x - hx, S.y - hy) < TAIL.reachS) ((a.hitS = true), hitShuttle(p, "tail"));
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
    bolts.push({ owner: p, x: p.x + p.face * 14, y: p.y - 15, vx: p.face * ZAP.speed, life: 1.6, seed: (Math.random() * 1e6) | 0 });
  }
  if (a.t >= (a.type === "basic" ? BASIC.dur : a.type === "tail" ? TAIL.dur : ZAP.dur)) p.act = null;
}
// Iron Tail has no key of its own: a basic attack that meets the shuttle in mid-air becomes it. Pikachu spins,
// the tail turns to steel and the shuttle is smashed. It only ever hits the shuttle, never the other player.
function ironTail(p) {
  p.act = { type: "tail", t: TAIL.on, hitS: true, hitP: true, fired: false, fx: false };
  hitShuttle(p, "tail");
}
const canHitShuttle = (p) => S.state === "fly" || (S.state === "serve" && game.server === p);

// ---------------------------------------------------------------- shuttle and bolts
function followServer() {
  const s = game.server;
  S.x = s.x + s.face * 12;
  S.y = s.y - 30 + Math.sin(game.time * 4) * 1.5;
}
function updateShuttle(dt) {
  if (S.state === "serve") return followServer();
  if (S.state !== "fly") return;
  const n = 4, h = dt / n;
  for (let i = 0; i < n; i++) {
    const v = Math.hypot(S.vx, S.vy);
    S.vx += -SH_K * v * S.vx * h;
    S.vy += (SH_G - SH_K * v * S.vy) * h;
    const px = S.x;
    S.x += S.vx * h;
    S.y += S.vy * h;
    // the net: anything under the tape bounces back off it
    if ((px - NET_X) * (S.x - NET_X) <= 0 && px !== S.x && S.y > NET_TOP && S.y < NET_BOTTOM) {
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
};
const ai = { on: false, level: "normal", plan: null, lastBy: null, reactAt: 0, replanAt: 0, err: 0, skip: false, wantSmash: false, shotKeys: [], shotUntil: 0, serveAt: 0, dodged: new Set() };
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

// where the shuttle will be, frame by frame, until it lands (same integrator and net as updateShuttle)
function predictShuttle(maxT = 2.5) {
  const out = [], h = DT / 4;
  let x = S.x, y = S.y, vx = S.vx, vy = S.vy;
  for (let t = DT; t <= maxT; t += DT) {
    for (let k = 0; k < 4; k++) {
      const v = Math.hypot(vx, vy);
      vx += -SH_K * v * vx * h;
      vy += (SH_G - SH_K * v * vy) * h;
      const px = x;
      x += vx * h;
      y += vy * h;
      if ((px - NET_X) * (x - NET_X) <= 0 && px !== x && y > NET_TOP && y < NET_BOTTOM) (x = px), (vx = -vx * 0.15), (vy = Math.max(vy, 0) * 0.4);
      if (y >= FLOOR) return out.push({ t, x, y: FLOOR, vy, land: true }), out;
    }
    out.push({ t, x, y, vy });
  }
  return out;
}

// pick the point to meet the shuttle: a jump smash if it comes high enough (and we feel like it), else a ground hit
function aiPlan(me) {
  const path = predictShuttle(), mine = (s) => (me === P2 ? s.x > NET_X + 8 : s.x < NET_X - 8);
  const reach = (s) => Math.abs(s.x - me.face * 12 - me.x) <= RUN * s.t + (AI_LEVELS[ai.level].dash && me.cd.quick <= 0 ? 70 : 0) + 14;
  if (ai.wantSmash) {
    const high = path.find((s) => mine(s) && s.vy > 0 && s.y > FLOOR - 82 && s.y < FLOOR - 52 && reach(s));
    if (high) return { ...high, smash: true };
  }
  const low = path.find((s) => mine(s) && s.vy > 0 && s.y > FLOOR - 32 && reach(s)) ?? path.find((s) => mine(s) && s.vy > 0 && s.y > FLOOR - 32);
  return low ? { ...low, smash: false } : null;
}

function aiStep() {
  const me = P2, op = P1, L = AI_LEVELS[ai.level], k = me.ctl, now = game.time;
  const held = AI_SRC.held, press = (a) => AI_SRC.pressed.add(k[a][0]), hold = (a) => held.add(k[a][0]);
  AI_SRC.pressed.clear();
  held.clear();
  if (game.state === "title" || game.state === "over" || game.paused || me.stun > 0 || me.knocked) return;
  const fwd = me.face > 0 ? "right" : "left", back = me.face > 0 ? "left" : "right";
  const home = me === P2 ? 290 : 94;

  // a shot is out: keep its direction key down until the swing is over
  if (now < ai.shotUntil) ai.shotKeys.forEach(hold);
  const chooseShot = (serve) => {
    const r = Math.random(), opNearNet = Math.abs(op.x - NET_X) < 60, opDeep = Math.abs(op.x - NET_X) > 130;
    ai.shotKeys = serve ? (r < 0.6 ? [] : r < 0.8 ? [back] : ["down"])
      : opNearNet ? (r < 0.6 ? [] : [back])
      : opDeep ? (r < 0.5 ? ["down"] : r < 0.8 ? [fwd] : [])
      : [[], [fwd], [back], ["down"]][(r * 4) | 0];
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
  }
  let target = home;
  if (S.last === op && now >= ai.reactAt) {
    if (!ai.plan || now >= ai.replanAt) (ai.plan = aiPlan(me)), (ai.plan && (ai.plan.at = now)), (ai.replanAt = now + 0.15);
    if (ai.plan) target = clamp(ai.plan.x - me.face * 12 + ai.err, me === P2 ? NET_X + 10 : 12, me === P2 ? W - 12 : NET_X - 10);
  }
  const dx = target - me.x, left = ai.plan ? ai.plan.t - (now - ai.plan.at) : 9;
  if (Math.abs(dx) > 3) hold(dx > 0 ? "right" : "left");
  // far and running out of time: Quick Attack towards it
  if (L.dash && ai.plan && Math.abs(dx) > 55 && left < Math.abs(dx) / RUN && me.cd.quick <= 0 && me.quickT <= 0) press("quick");
  // a high one: jump so the swing meets it at the top (the swing then becomes Iron Tail)
  if (ai.plan?.smash && me.ground && Math.abs(dx) < 16 && left < 0.32 && left > 0.12) press("up");

  // swing when the shuttle is in reach
  const hx = me.x + me.face * 12, hy = me.y - 18;
  if (!ai.skip && !me.act && S.last !== me && Math.hypot(S.x - hx, S.y - hy) < BASIC.reachS * 0.95) {
    if (me.ground) chooseShot(false);
    else (ai.shotKeys = []), (ai.shotUntil = 0);
    ai.shotKeys.forEach(hold);
    press("basic");
  }

  // zap the other player now and then, when nothing more urgent is going on
  if (me.cd.zap <= 0 && !me.act && me.ground && op.ground && Math.abs(op.x - me.x) > 50 && left > 0.8 && Math.random() < L.zap * DT) press("zap");
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

function step(dt) {
  if (game.hold) return; // debug: freeze the world for screenshots
  game.time += dt;
  if (anyPressed(["Escape", "KeyP"]) && (game.state === "serve" || game.state === "rally" || game.state === "point")) game.paused = !game.paused;
  if (game.paused) return;
  if ((game.state === "title" || game.state === "over") && anyPressed(["Enter", "Space"])) newGame();

  if (game.msg && (game.msg.t += dt) > game.msg.dur) game.msg = null;
  game.shakeT = Math.max(0, game.shakeT - dt);
  if (game.freeze > 0) {
    game.freeze -= dt;
    return;
  }

  if (ai.on) aiStep();
  for (const p of PLAYERS) updatePlayer(p, dt);
  updateShuttle(dt);
  updateBolts(dt);

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

// a sprite without squash frames, squashed flat with its feet kept on the floor (nearest-pixel resampling, so it stays crisp)
function drawSquashed(P, spr, pal, amount, tint) {
  const sy = 1 - (1 - SQUASH.y) * amount, sx = 1 + (SQUASH.x - 1) * amount;
  const w = spr.rows[0].length, h = spr.rows.length, w2 = Math.round(w * sx), h2 = Math.max(1, Math.round(h * sy));
  const x0 = Math.round(spr.ax * sx), y0 = -h2, cache = {};
  for (let ty = 0; ty < h2; ty++) {
    const row = spr.rows[Math.min(h - 1, Math.floor(ty / sy))];
    for (let tx = 0; tx < w2; tx++) {
      const ch = row[Math.min(w - 1, Math.floor(tx / sx))];
      if (ch === "." || ch === " ") continue;
      P.dot(x0 + tx, y0 + ty, tint ?? (cache[ch] ??= C(pal[ch])));
    }
  }
}

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
  if (p.quickT > 0 && p.quickDir !== "up") {
    P.place(0, 0);
    for (let i = 0; i < 4; i++) {
      const ly = p.y - 6 - i * 7, len = 10 + ((i * 7 + Math.floor(game.time * 60)) % 9);
      P.rect(Math.round(p.x - p.quickDir * (14 + len)), Math.round(ly), len, 1, C("#fff6c8"), 0.8);
    }
  }
  P.place(Math.round(p.x + ox), Math.round(p.y + oy), flip);
  const pose = squashFrame(spr, p.squash) ?? spr;
  if (!blinkOff) {
    if (!spr.squash.length && p.squash > 0.02) drawSquashed(P, spr, pal, p.squash, tint);
    else P.sprite(pose.rows, pal, pose.ax, pose.ay, { tint });
  }

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
  const top = spr.squash.length ? pose.ay : Math.round(spr.ay * (1 - (1 - SQUASH.y) * p.squash)); // shorter while squashed
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
      const x = x0 + i * 30, y = 20, ready = p.cd[key] <= 0, k = 1 - p.cd[key] / cd;
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
}

function render() {
  clearFrame(frame);
  let P = painterFor(frame);
  for (const e of effects) if (e.shown !== false) e.fx.draw(frame, "back");
  P = painterFor(frame);
  drawNet(P);
  for (const d of dust) P.dot(d.x, d.y, d.c, 1 - d.life / d.max);
  for (const p of PLAYERS) drawPlayer(p, P);
  drawShuttle(P);
  for (const b of bolts) drawBolt(P, b);
  for (const e of effects) if (e.shown !== false) e.fx.draw(frame, "front");
  P = painterFor(frame);
  drawHud(P);
  drawOverlay(P);
}

// ---------------------------------------------------------------- online (PeerJS: browser-to-browser WebRTC)
// The host's browser runs the game. The guest sends key presses on a reliable "ctl" channel and draws the
// snapshots the host streams on an unreliable "state" channel. Effects are sent once (with their seed) on "ctl",
// and snapshots carry only their clock and position, so both screens show the same sparks.
const ROOM_PREFIX = "pika-badminton-v1-";
const net = { mode: "local", peer: null, ctl: null, state: null, code: null, seq: 0, lastSeq: -1, lastSend: 0, ping: null, pinger: 0, p2Epoch: 0, p2Reports: [], p2Offs: [] };
const fxById = new Map();
const myId = () => (net.mode === "guest" ? 2 : 1);
const sendCtl = (msg) => net.ctl?.open && net.ctl.send(msg);

function setMode(mode) {
  net.mode = mode;
  REMOTE.held.clear();
  REMOTE.pressed.clear();
  if (mode === "local") (P1.ctl = CONTROLS[1]), (P2.ctl = CONTROLS[2]), (P1.src = P2.src = LOCAL);
  else (P1.ctl = P2.ctl = ANY), (P1.src = LOCAL), (P2.src = REMOTE);
  // the AI only plays offline: going online sends it home, coming back brings it back if it was on
  if (mode !== "local") (P2.spr = SPR_P2), (ai.wasOn = ai.wasOn || ai.on), (ai.on = false);
  else if (ai.wasOn) (ai.wasOn = false), setAI(ai.level);
  ui.sync();
}
function toTitle() {
  effects.length = 0;
  fxById.clear();
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
  clearInterval(net.pinger);
  try { net.ctl?.close(); net.state?.close(); net.peer?.destroy(); } catch {}
  Object.assign(net, { peer: null, ctl: null, state: null, code: null, ping: null, lastSeq: -1, route: null, peerNat: null, connText: null, p2Reports: [], p2Offs: [] });
  resetGuest();
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
function startPinging() {
  clearInterval(net.pinger);
  net.pinger = setInterval(() => sendCtl({ t: "ping", ts: performance.now() }), 1000);
}
function onCtl(d) {
  if (d.t === "k") {
    if (d.d) (REMOTE.held.add(d.c), REMOTE.pressed.add(d.c));
    else REMOTE.held.delete(d.c);
  } else if (d.t === "rel") REMOTE.held.clear();
  else if (d.t === "ping") sendCtl({ t: "pong", ts: d.ts });
  else if (d.t === "pong") {
    net.ping = Math.round(performance.now() - d.ts);
    ui.ping(net.ping);
  } else if (d.t === "fx" && net.mode === "guest") {
    const mod = MODS[d.m];
    if (!mod) return;
    const o = { ...d.o };
    if (o.actor) o.actor = ACTOR;
    else delete o.actor;
    const e = { fx: createFx(mod, o), id: d.id };
    effects.push(e);
    fxById.set(d.id, e);
  } else if (d.t === "nat") {
    net.peerNat = String(d.v).slice(0, 60);
    refreshConn();
  } else if (d.t === "full") {
    leave(true);
    ui.status("그 방은 이미 두 명이 차 있어요.", "warn");
  }
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
    if (conn.label === "state") return void ((net.state = conn), conn.on("data", onGuestMove));
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
      startPinging();
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
    const st = peer.connect(id, { label: "state", reliable: false, serialization: "json" });
    Object.assign(net, { ctl, state: st });
    watchConn(ctl, "guest");
    watchConn(st, "guest");
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
      effects.length = 0;
      fxById.clear();
      resetGuest();
      setMode("guest");
      startPinging();
      showRoute(ctl, "연결됐어요! 나는 2P예요. 방장이나 내가 Enter를 누르면 시작해요", code);
    });
    ctl.on("data", onCtl);
    ctl.on("close", onDisconnect);
    st.on("data", onSnapshot);
  });
  peer.on("error", (err) => {
    if (err.type === "peer-unavailable") (leave(true), ui.status("그 코드의 방을 찾을 수 없어요. 코드를 다시 확인해 주세요.", "warn"));
    else ui.status(`연결 오류 (${err.type}). 다시 시도해 주세요.`, "warn");
  });
}

// ---- snapshots (host → guest)
const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
function snapshot() {
  const m = game.msg;
  return {
    seq: ++net.seq,
    fx: fxId,
    ep: net.p2Epoch, // bumped whenever the host itself moves 2P (new rally, a hit): the guest re-syncs to it
    g: [game.state, r3(game.time), game.server.id, game.paused ? 1 : 0, r3(game.shakeT), game.shakeA, m ? [m.text, m.color, r3(m.t), m.dur, m.y] : 0],
    p: PLAYERS.map((p) => [
      r1(p.x), r1(p.y), r1(p.vx), p.face, p.ground ? 1 : 0, p.act ? [p.act.type, r3(p.act.t)] : 0,
      r3(p.cd.zap), r3(p.cd.tail), r3(p.cd.quick), r3(p.quickT), p.quickDir, r3(p.stun), p.stunKind, p.knocked ? 1 : 0, r3(p.iframes),
      p.trail.map((g) => [r1(g.x), r1(g.y), g.flip ? 1 : 0, r3(g.a)]), p.score, r1(p.vy), Math.round(p.squash * 100) / 100,
    ]),
    s: [r1(S.x), r1(S.y), r1(S.vx), r1(S.vy), S.state, r3(S.smash), S.trail.map((t) => [r1(t.x), r1(t.y)])],
    b: bolts.map((b) => [r1(b.x), r1(b.y), b.vx, b.seed]),
    d: dust.map((d) => [r1(d.x), r1(d.y), d.c, r3(d.life), r3(d.max)]),
    m: marks.map((k) => [r1(k.x), r3(k.t), k.inside ? 1 : 0]),
    e: effects.map((e) => [e.id, r3(e.fx.t), e.fx.options.x, e.fx.options.y, e.fx.options.flip ? 1 : 0, e.stopped ? 1 : 0]),
  };
}
// draw one snapshot's state (the guest calls this every frame with the snapshot it is showing)
function applyState(d) {
  const [st, time, sid, paused, shakeT, shakeA, m] = d.g;
  Object.assign(game, { state: st, time, paused: !!paused, shakeT, shakeA, server: sid === 1 ? P1 : P2 });
  game.msg = m ? { text: m[0], color: m[1], t: m[2], dur: m[3], y: m[4] } : null;
  d.p.forEach((a, i) => {
    const p = PLAYERS[i];
    [p.x, p.y, p.vx, p.face] = a;
    p.ground = !!a[4];
    p.act = a[5] ? { type: a[5][0], t: a[5][1] } : null;
    p.cd = { zap: a[6], tail: a[7], quick: a[8] };
    [p.quickT, p.quickDir, p.stun, p.stunKind] = [a[9], a[10], a[11], a[12]];
    p.knocked = !!a[13];
    p.iframes = a[14];
    p.trail = a[15].map(([x, y, f, al]) => ({ x, y, flip: !!f, a: al }));
    p.score = a[16];
    p.squash = a[18] ?? 0;
  });
  [S.x, S.y, S.vx, S.vy, S.state, S.smash] = d.s;
  S.trail = d.s[6].map(([x, y]) => ({ x, y }));
  bolts.length = 0;
  for (const [x, y, vx, seed] of d.b) bolts.push({ x, y, vx, seed });
  dust.length = 0;
  for (const [x, y, c, life, max] of d.d) dust.push({ x, y, c, life, max });
  marks.length = 0;
  for (const [x, t, inside] of d.m) marks.push({ x, t, inside: !!inside });
  // effects: catch each one up to the host's clock; drop the ones the host has finished; hide the ones that
  // arrived early (their spawn message beats the snapshot we are showing) until the shown time reaches them
  const alive = new Set();
  for (const [id, t, x, y, flip, stopped] of d.e) {
    alive.add(id);
    const e = fxById.get(id);
    if (!e) continue;
    Object.assign(e.fx.options, { x, y, flip: !!flip });
    if (t > e.fx.t) e.fx.update(t - e.fx.t);
    if (stopped && !e.stopped) (e.fx.stop(), (e.stopped = true));
  }
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.shown = alive.has(e.id);
    if (!e.shown && e.id <= d.fx) (effects.splice(i, 1), fxById.delete(e.id));
  }
}

// ---- 2P (the guest): smooth playback of the host's game, and its own Pikachu predicted locally
// Snapshots are kept for a moment and the game is drawn INTERP seconds behind the newest one, blending
// between the two around that time, so uneven packet arrival no longer shows as stutter or jumps.
// The guest's own Pikachu does not wait for the round trip at all: it is moved here as keys are pressed
// (same rules as updatePlayer) and its position is sent to the host, which uses it while 2P moves freely.
// When the host moves 2P itself (a hit, a stun, a new rally) it bumps an epoch and the guest snaps to it.
const INTERP = 0.05;
const guest = { snaps: [], offs: [], latest: null, sendAt: 0 };
const own = { epoch: -1, follow: true, n: 0, squash: 0, x: 288, y: FLOOR, vx: 0, vy: 0, ground: true, face: -1, quickT: 0, quickDir: null, cd: { zap: 0, quick: 0 }, act: null, trail: [] };
function resetGuest() {
  Object.assign(guest, { snaps: [], offs: [], latest: null });
  Object.assign(own, { epoch: -1, follow: true, act: null, trail: [] });
}
function onSnapshot(d) {
  if (net.mode !== "guest" || d.seq <= net.lastSeq) return; // unreliable channel: drop late arrivals
  net.lastSeq = d.seq;
  d.host = d.g[1];
  guest.offs.push(performance.now() / 1000 - d.host); // arrival time minus host time; the smallest is the least delayed
  if (guest.offs.length > 120) guest.offs.shift();
  guest.snaps.push(d);
  if (guest.snaps.length > 60) guest.snaps.shift();
  guest.latest = d;
  const a = d.p[1], hurt = a[11] > 0 || a[13];
  if (hurt || d.ep !== own.epoch) {
    // the host is moving 2P (or a new rally started): take its state as ours
    Object.assign(own, { x: a[0], y: a[1], vx: a[2], vy: a[17] ?? 0, face: a[3], ground: !!a[4], quickT: a[9], quickDir: a[10], act: null, trail: [] });
    own.cd = { zap: a[6], quick: a[8] };
    own.epoch = d.ep;
  }
  own.follow = !!hurt;
}
// one fixed step of our own Pikachu (the movement half of updatePlayer; hits and scoring stay on the host)
function predictSelf(dt) {
  const L = guest.latest;
  if (!L || own.follow) return;
  const p = own, c = ANY, has = (k) => k.some((x) => held.has(x)), hit = (k) => k.some((x) => pressed.has(x));
  const dirX = (has(c.right) ? 1 : 0) - (has(c.left) ? 1 : 0), st = L.g[0];
  p.cd.zap = Math.max(0, p.cd.zap - dt);
  p.cd.quick = Math.max(0, p.cd.quick - dt);
  if (st !== "title" && st !== "over" && !L.g[3]) {
    if (!p.act && p.quickT <= 0 && Math.abs(P1.x - p.x) > 1) p.face = Math.sign(P1.x - p.x);
    if (hit(c.quick) && p.cd.quick <= 0 && p.quickT <= 0) {
      Object.assign(p, { act: null, quickT: QUICK.dur });
      p.cd.quick = QUICK.cd;
      if (has(c.up)) Object.assign(p, { quickDir: "up", vy: -QUICK.up, ground: false, vx: dirX * RUN });
      else {
        const d = dirX === -p.face ? -p.face : p.face;
        Object.assign(p, { quickDir: d, vx: d * QUICK.speed, vy: 0 });
      }
    } else if (!p.act && p.quickT <= 0) {
      if (hit(c.zap) && p.cd.zap <= 0) (p.act = { type: "zap", t: 0 }), (p.cd.zap = ZAP.cd);
      else if (hit(c.basic)) p.act = { type: "basic", t: 0 };
    }
    if (hit(c.up) && p.ground && p.quickT <= 0) (p.vy = -JUMP_V), (p.ground = false);
    if (p.quickT > 0) {
      p.quickT -= dt;
      if (p.quickDir === "up") p.vx = dirX * RUN * 1.2;
    } else p.vx = dirX * RUN * (p.act ? 0.55 : 1);
  } else p.vx = 0;
  if (!(p.quickT > 0 && p.quickDir !== "up")) p.vy += GRAV * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  if (p.y >= FLOOR) (p.y = FLOOR), (p.vy = 0), (p.ground = true);
  else p.ground = false;
  p.x = clamp(p.x, 12, W - 12);
  if (st === "serve") {
    const gap = L.g[2] === 2 ? SERVICE_LINE : SERVE_GAP;
    if (p.x < NET_X + gap) (p.x = NET_X + gap), (p.vx = Math.max(p.vx, 0));
  }
  if (p.quickT > 0) p.trail.push({ x: p.x, y: p.y, flip: p.face > 0, a: 0.8 });
  for (const g of p.trail) g.a -= dt * 4;
  p.trail = p.trail.filter((g) => g.a > 0).slice(-6);
  if (p.act && (p.act.t += dt) >= (p.act.type === "zap" ? ZAP.dur : BASIC.dur)) p.act = null;
  const squashTo = p.ground && st !== "title" && st !== "over" && has(c.down) ? 1 : 0;
  p.squash += (squashTo - p.squash) * Math.min(1, dt * SQUASH.rate);
}
function sendSelf(now) {
  if (own.follow || own.epoch < 0 || !net.state?.open || now - guest.sendAt < 15) return;
  guest.sendAt = now;
  net.state.send({ t: "pos", n: ++own.n, ep: own.epoch, tm: r3(now / 1000), x: r1(own.x), y: r1(own.y), vx: r1(own.vx), vy: r1(own.vy), g: own.ground ? 1 : 0, f: own.face, q: r3(own.quickT), qd: own.quickDir, cq: r3(own.cd.quick) });
}
// what the guest draws this frame
function showGuest(now) {
  const snaps = guest.snaps;
  if (!snaps.length) return;
  const H = now / 1000 - Math.min(...guest.offs) - INTERP; // the host time we are showing
  let i = snaps.length - 1;
  while (i > 0 && snaps[i].host > H) i--;
  const A = snaps[i], B = snaps[i + 1] ?? A, k = B === A ? 0 : clamp((H - A.host) / (B.host - A.host));
  if (i > 1) snaps.splice(0, i - 1);
  applyState(A);
  if (B !== A) {
    const mix = (a, b) => a + (b - a) * k;
    for (let n = 0; n < 2; n++) (PLAYERS[n].x = mix(A.p[n][0], B.p[n][0])), (PLAYERS[n].y = mix(A.p[n][1], B.p[n][1]));
    if (A.s[4] === "fly" && B.s[4] === "fly" && Math.hypot(B.s[0] - A.s[0], B.s[1] - A.s[1]) < 60) (S.x = mix(A.s[0], B.s[0])), (S.y = mix(A.s[1], B.s[1]));
    for (const b of bolts) {
      const m = B.b.find((q) => q[3] === b.seed);
      if (m) b.x = mix(b.x, m[0]);
    }
  }
  const L = guest.latest.p[1];
  // being hit shows as soon as it is known, not INTERP later
  [P2.stun, P2.stunKind, P2.knocked, P2.iframes] = [L[11], L[12], !!L[13], L[14]];
  if (!own.follow) {
    // our own Pikachu, where we predict it (while the host moves us after a hit, its smoothed 2P is shown instead)
    Object.assign(P2, { x: own.x, y: own.y, vx: own.vx, face: own.face, ground: own.ground, quickT: own.quickT, quickDir: own.quickDir, trail: own.trail, squash: own.squash });
    P2.cd = { ...P2.cd, zap: own.cd.zap, quick: own.cd.quick };
    // our swing shows at once; an Iron Tail (decided by the host when a jump swing meets the shuttle) shows from the host
    P2.act = L[5] && L[5][0] === "tail" ? { type: "tail", t: L[5][1] } : own.act;
  }
  // a shuttle waiting to be served sits in the server's hand as drawn here, not where the snapshot had it
  if (S.state === "serve") followServer();
}
// the host's side: the guest's latest report of where its 2P is
// Reports arrive unevenly, so 2P is played back INTERP behind the newest one, blending between the two around
// that moment (on the guest's own clock, sent with each report) instead of jumping to each as it lands.
function onGuestMove(d) {
  if (d?.t !== "pos" || net.mode !== "host") return;
  const list = net.p2Reports, last = list[list.length - 1], now = performance.now();
  if (last && d.ep === last.ep && d.n <= last.n) return; // arrived late
  if (last && d.ep !== last.ep) list.length = 0; // a new epoch starts a new track
  list.push({ ...d, at: now });
  if (list.length > 40) list.shift();
  net.p2Offs.push(now / 1000 - d.tm); // arrival minus send time; the smallest is the least delayed
  if (net.p2Offs.length > 120) net.p2Offs.shift();
}
function guestMove(p) {
  const list = net.p2Reports, last = list[list.length - 1];
  if (net.mode !== "host" || p !== P2 || !last || last.ep !== net.p2Epoch || p.knocked || p.stun > 0) return null;
  if (performance.now() - last.at > 250) return null; // stale (connection hiccup): fall back to the guest's keys
  const T = performance.now() / 1000 - Math.min(...net.p2Offs) - INTERP; // the guest's moment we show
  let i = list.length - 1;
  while (i > 0 && list[i].tm > T) i--;
  const A = list[i], B = list[i + 1] ?? A, k = B === A ? 0 : clamp((T - A.tm) / (B.tm - A.tm));
  if (i > 1) list.splice(0, i - 1);
  const mix = (a, b) => a + (b - a) * k;
  return { ...A, x: mix(A.x, B.x), y: mix(A.y, B.y), vx: mix(A.vx, B.vx), vy: mix(A.vy, B.vy) };
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
    ping(ms) {
      el.ping.textContent = `핑 ${ms}ms`;
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

// ---- choosing the opponent: the AI at one of three levels, or two people on one device
(() => {
  const buttons = [...document.querySelectorAll("[data-ai]")], status = document.getElementById("mode-status");
  if (!buttons.length) return;
  const show = () => {
    const level = net.mode === "local" && ai.on ? ai.level : net.mode === "local" ? "" : null;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.ai === level));
    status.textContent =
      net.mode !== "local" ? "온라인 대전 중에는 고를 수 없어요."
      : ai.on ? `AI(${{ easy: "쉬움", normal: "보통", hard: "어려움" }[ai.level]})와 대전해요. 나는 1P예요. ${TOUCH ? "START나 화면을 누르면" : "Enter를 누르면"} 시작해요.`
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
// advance the game (and stream it to the guest); drawing happens only in frameLoop
function tick(now) {
  acc = Math.min(acc + (now - last) / 1000, 0.25);
  last = now;
  if (net.mode === "guest") {
    // the host runs the game; we move our own Pikachu ahead of it, tell the host where it is, and draw the
    // host's game a moment behind, smoothed (see showGuest)
    while (acc >= DT) {
      predictSelf(DT);
      pressed.clear();
      acc -= DT;
    }
    sendSelf(now);
    showGuest(now);
  } else {
    while (acc >= DT) {
      step(DT);
      pressed.clear();
      REMOTE.pressed.clear();
      acc -= DT;
    }
    if (net.mode === "host" && net.state?.open && now - net.lastSend >= 15) {
      net.lastSend = now;
      net.state.send(snapshot());
    }
  }
}
// A hidden tab gets no animation frames, which would freeze the host's game for both players.
// Timers inside a worker keep running in the background, so they keep the host ticking.
const bgTicker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 16)"], { type: "text/javascript" })));
let lastFrame = performance.now();
bgTicker.onmessage = () => {
  const now = performance.now();
  if (net.mode === "host" && now - lastFrame > 100) tick(now); // frames have stalled: tab hidden or covered
};
function frameLoop(now) {
  lastFrame = performance.now();
  tick(now);
  render();
  composite(frame, img.data, BG);
  const s = game.shakeT > 0 ? game.shakeA : 0;
  ctx.fillStyle = "#0b0a12";
  ctx.fillRect(0, 0, W, H);
  ctx.putImageData(img, Math.round((Math.random() - 0.5) * 2 * s), Math.round((Math.random() - 0.5) * 2 * s));
  requestAnimationFrame(frameLoop);
}
P1.x = 96;
P2.x = 288;
followServer();
requestAnimationFrame(frameLoop);

// debug handle for testing in the console
window.__pika = { game, P1, P2, S, effects, bolts, step, held, pressed, net, iceReport, snapshot, natType, ai, setAI, toTitle, isMacChrome, own, guest, tick: (t) => tick(t), renderOnce: () => (render(), composite(frame, img.data, BG)), paint: () => (render(), composite(frame, img.data, BG), ctx.putImageData(img, 0, 0)) };
