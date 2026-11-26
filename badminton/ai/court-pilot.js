import { makePilot } from "./return-pilot.js";

const keyMirror = {
  KeyA: "ArrowRight",
  KeyD: "ArrowLeft",
  KeyW: "ArrowUp",
  KeyS: "ArrowDown",
  KeyF: "KeyK",
  KeyH: "Semicolon",
  KeyG: "KeyL",
};
const WIDTH = 384;

export function courtPilot(engine, side, config, chooseAction = null, inputs = null) {
  const { game, P1, P2, S, bolts, keyDown, keyUp } = engine;
  const flip = side === 2;
  const viewPlayer = (p) =>
    Object.freeze({
      get x() {
        return flip ? WIDTH - p.x : p.x;
      },
      get y() {
        return p.y;
      },
      get vx() {
        return flip ? -p.vx : p.vx;
      },
      get vy() {
        return p.vy;
      },
      get face() {
        return flip ? -p.face : p.face;
      },
      get ground() {
        return p.ground;
      },
      get quickT() {
        return p.quickT;
      },
      get dashX() {
        return flip ? -p.dashX : p.dashX;
      },
      get dashY() {
        return p.dashY;
      },
      get iframes() {
        return p.iframes;
      },
      get act() {
        return p.act && Object.freeze({ ...p.act });
      },
      get cd() {
        return Object.freeze({ ...p.cd });
      },
      get noHit() {
        return p.noHit;
      },
      get stun() {
        return p.stun;
      },
      get knocked() {
        return p.knocked;
      },
    });
  const left = viewPlayer(P1),
    right = viewPlayer(P2);
  const ref = (p) => (p === P1 ? left : p === P2 ? right : null);
  const observations = {
    P1: flip ? right : left,
    P2: flip ? left : right,
    game: Object.freeze({
      get time() {
        return game.time;
      },
      get state() {
        return game.state;
      },
      get freeze() {
        return game.freeze;
      },
      get paused() {
        return game.paused;
      },
      get server() {
        return ref(game.server);
      },
    }),
    S: Object.freeze({
      get x() {
        return flip ? WIDTH - S.x : S.x;
      },
      get y() {
        return S.y;
      },
      get vx() {
        return flip ? -S.vx : S.vx;
      },
      get vy() {
        return S.vy;
      },
      get state() {
        return S.state;
      },
      get last() {
        return ref(S.last);
      },
    }),
    // Keep the same collection identity because the pilot captures it once.
    bolts: [],
  };
  const pilot = makePilot(
    observations,
    (type, key) => {
      if (!Object.hasOwn(keyMirror, key)) throw new Error(`Unsupported pilot key: ${key}`);
      const physical = flip ? keyMirror[key] : key;
      if (inputs) {
        if (type === "keydown") { inputs.held.add(physical); inputs.pressed.add(physical); }
        else inputs.held.delete(physical);
      } else if (type === "keydown") keyDown(physical);
      else keyUp(physical);
    },
    {
      ...config,
      ...(chooseAction ? { smashBonus: 0, serveLob: 0, serveDrop: 0, chooseAction } : {}),
    },
  );
  return {
    prime: pilot.prime,
    tick() {
      observations.bolts.length = 0;
      for (const b of bolts)
        observations.bolts.push(
          Object.freeze({
            owner: ref(b.owner),
            x: flip ? WIDTH - b.x : b.x,
            y: b.y,
            vx: flip ? -b.vx : b.vx,
            life: b.life,
          }),
        );
      pilot.tick();
    },
  };
}
