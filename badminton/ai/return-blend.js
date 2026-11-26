import { courtPilot } from "./court-pilot.js";
import { RETURN_BLEND } from "./return-config.js";

const DT = 1 / 60;
const REGULAR_LIMIT = 100;
const commitment = ({ id }) => id === "dash" || id === "zap" ? 1 : id === "jump" ? 0.35 : 0;

// AI-assisted implementation (OpenAI ChatGPT).
// Forecast on an isolated court. Neither a hypothetical point nor keyboard input touches the live game.
export function makeReturnBlend(live, fork, side, inputs, nativeOpponent) {
  const opponentSide = 3 - side;
  let regularUsed = 0, lateUsed = 0, age = 0, lastLate = 0, lateThisRally = 0;
  let score = live.P1.score + live.P2.score;
  const canProbe = (kind) =>
    lateUsed < RETURN_BLEND.stallSearch && lateThisRally < 12 &&
    age >= 1650 && age - lastLate >= 620 &&
    ["shot", "approach", "pressure", "escape"].includes(kind);

  function choose(kind, options) {
    if (live.game.freeze > 0 || live.game.state === "point") return options[0];
    const late = kind === "escape" || regularUsed >= REGULAR_LIMIT;
    if (late && !canProbe(kind)) return options[0];
    if (late) {
      lateUsed++;
      lastLate = age;
      lateThisRally++;
    } else regularUsed++;
    const state = live.saveState();
    const against = nativeOpponent();
    const horizon = late ? Math.max(RETURN_BLEND.rolloutHorizon, 180) : RETURN_BLEND.rolloutHorizon;
    let best = options[0], value = -2;
    for (const action of options) {
      const next = fork.withForecastRandom(state.g.rng, () => {
        fork.toTitle();
        if (against) fork.setForecastOpponent(opponentSide, against);
        else fork.setAI(null);
        fork.loadState(state);
        fork.held.clear();
        fork.pressed.clear();
        const fallback = courtPilot(fork, side, RETURN_BLEND);
        const opponent = against ? null : courtPilot(fork, opponentSide, RETURN_BLEND);
        fallback.prime(action);
        opponent?.tick();
        const me = side === 1 ? fork.P1 : fork.P2;
        for (let frame = 0; frame < horizon; frame++) {
          fork.step(DT);
          fork.pressed.clear();
          if (fork.game.state === "point" || fork.game.state === "over") {
            return fork.game.pointWinner === me ? 1 : -1;
          }
          fallback.tick();
          opponent?.tick();
        }
        return 0;
      });
      if (next > value || (next === 1 && value === 1 && commitment(action) < commitment(best))) {
        best = action;
        value = next;
      }
    }
    return best;
  }
  choose.canProbe = canProbe;
  const pilot = courtPilot(live, side, RETURN_BLEND, choose, inputs);
  return {
    tick() {
      const updated = live.P1.score + live.P2.score;
      if (score !== updated) {
        score = updated;
        age = lastLate = lateThisRally = 0;
      } else if (live.game.state === "rally" || live.game.state === "serve") age++;
      inputs.pressed.clear();
      pilot.tick();
    },
  };
}
