// Contact scores for legal routes only. This does not award match or rollout points.
const styles = [
  { id: "drop", pace: -0.45, air: -8, ground: [0, 0, 0, 58] },
  { id: "drive", pace: 0.48, air: 0, ground: [0, 0, 35, 0] },
  { id: "lob", pace: -0.42, air: -12, ground: [0, 56, 0, 0] },
  { id: "smash", pace: 0.1, air: 108, ground: [0, 0, 0, 0] },
  { id: "wait-clear", pace: -1.28, air: -10, ground: [35, 0, 0, 0] },
];
const patterns = [
  [0, 1, 2, 3], // change depth, and only then go aerial
  [3, 0, 3, 2], // try a smash and vary recovery/ground response
  [4, 2, 0, 1], // change the time of contact before changing the shot
  [1, 4, 3, 0],
];

const late = [
  [4, 3, 0, 2, 1],
  [3, 1, 0, 4, 2],
  [0, 4, 2, 3, 4],
  [2, 0, 4, 3, 1],
];
const lateSpans = [1, 3, 5, 2];
const opening = [
  null,
  { ...styles[1], guard: 18 },
  { ...styles[2], guard: -13 },
  { ...styles[3], guard: 9, air: 68 },
  { ...styles[0], guard: 15 },
];
export function openingStyle(mode, serving, incoming, opponentX) {
  if (!mode || incoming > 3) return null;
  if (mode === 3 && !serving) return null;
  if (mode === 4) return opening[opponentX >= 275 ? 4 : 2];
  return opening[mode];
}

export function rallyBreakStyle(returns, after, pattern, opponentX, adaptive = 0, stallCycle = 0) {
  if (!after || returns < after) return null;
  const start = Math.max(26, after + 12);
  if (stallCycle && returns >= start) {
    // Enter a different cycle only after many live returns. Do not alter openings.
    const seq = late[stallCycle - 1];
    const i = Math.floor((returns - start) / lateSpans[stallCycle - 1]);
    return styles[seq[i % seq.length]];
  }
  const order = patterns[pattern];
  // Keep a style for two incoming shots so it can shape an exchange.
  const phase = Math.floor((returns - after) / 2);
  // Coordinates are relative to the pilot. Adapt every other phase so a
  // stationary opponent cannot force the same response for the entire rally.
  if (adaptive && phase % 2 === 0) {
    if (opponentX <= 257) return styles[adaptive === 1 ? 2 : 3]; // front: lob or smash
    if (opponentX >= 280) return styles[0]; // deep: short drop
    if (adaptive === 2) return styles[1];
  }
  return styles[order[phase % order.length]];
}
