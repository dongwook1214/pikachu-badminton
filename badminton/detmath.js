// Math that gives bit-for-bit the same answer in every browser.
// Online, both browsers run the whole game and must stay identical (see rollback.js). Math.sin, Math.cos,
// Math.atan2 and Math.hypot are only approximated by the spec, and Chrome (V8) and Safari (JavaScriptCore) use
// different libraries for them, so the last bit can differ and two games drift apart. These are built from
// + - * / and Math.sqrt alone, which IEEE 754 rounds exactly, the same everywhere.
// tests/detmath.test.mjs checks them against Math.* and runs the same numbers in V8 and JavaScriptCore.

const PI = 3.141592653589793, HALF_PI = PI / 2, TWO_PI = 2 * PI;

/** sin(x), to about 1e-15 for game-sized angles. */
export function dsin(x) {
  x -= TWO_PI * Math.round(x / TWO_PI); // [-PI, PI]
  if (x > HALF_PI) x = PI - x; // [-PI/2, PI/2]: sin(PI - x) = sin(x)
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  // Taylor series to x^19 (the next term is under 1e-16 at PI/2)
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 +
    x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000 + x2 * (1 / 355687428096000 + x2 * (-1 / 121645100408832000))))))))));
}

/** cos(x) */
export const dcos = (x) => dsin(x + HALF_PI);

/** atan(t), any finite t. */
export function datan(t) {
  // atan(t) = 2 atan(t / (1 + sqrt(1 + t^2))): three halvings bring |t| under tan(PI/16) ~ 0.2
  for (let i = 0; i < 3; i++) t = t / (1 + Math.sqrt(1 + t * t));
  const t2 = t * t;
  let s = 0;
  for (let n = 23; n >= 1; n -= 2) s = 1 / n - t2 * s; // 1 - t^2/3 + t^4/5 - ... (Horner, from the far end)
  return 8 * t * s;
}

/** atan2(y, x) */
export function datan2(y, x) {
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  return y > 0 ? HALF_PI : y < 0 ? -HALF_PI : 0;
}

/** hypot(x, y) */
export const dhypot = (x, y) => Math.sqrt(x * x + y * y);
