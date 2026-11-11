// node tests/detmath.test.mjs
// 1. detmath.js is accurate (close to Math.*)
// 2. it is deterministic across engines: the fingerprint is the same in Node (V8) and, on a Mac, jsc (JavaScriptCore)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dsin, dcos, datan2, dhypot } from "../badminton/detmath.js";

let worst = 0;
for (let i = 0; i < 200000; i++) {
  const a = (Math.random() - 0.5) * 100, y = (Math.random() - 0.5) * 1000, x = (Math.random() - 0.5) * 1000;
  worst = Math.max(worst, Math.abs(dsin(a) - Math.sin(a)), Math.abs(dcos(a) - Math.cos(a)), Math.abs(datan2(y, x) - Math.atan2(y, x)), Math.abs(dhypot(x, y) - Math.hypot(x, y)) / Math.hypot(x, y));
}
for (const [y, x] of [[0, 1], [0, -1], [1, 0], [-1, 0], [0, 0], [1e-9, 1], [1e9, 1], [-1e9, -1], [5, -1e-12]]) worst = Math.max(worst, Math.abs(datan2(y, x) - Math.atan2(y, x)));
assert.ok(worst < 1e-12, `detmath is off by ${worst}`);
console.log(`accuracy ok (worst error ${worst.toExponential(2)})`);

const fp = fileURLToPath(new URL("./detmath.fingerprint.mjs", import.meta.url));
const v8 = execFileSync(process.execPath, [fp], { encoding: "utf8" }).trim();
const JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc";
if (existsSync(JSC)) {
  const jsc = execFileSync(JSC, ["-m", fp], { encoding: "utf8" }).trim();
  assert.equal(jsc, v8, `V8 and JavaScriptCore disagree: ${v8} vs ${jsc}`);
  console.log(`same bits in V8 and JavaScriptCore (fingerprint ${v8})`);
} else console.log(`fingerprint ${v8} (jsc not found: cross-engine check skipped)`);
