import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, KP_STORM, TIER, XRAY_SCALE_M, XRAY_SCALE_X } from "../src/events.js";

const mathRs = readFileSync(new URL("../../sunfire-program/programs/sunfire/src/math.rs", import.meta.url), "utf8");
const rustConst = (name) => Number(mathRs.match(new RegExp(`pub const ${name}: u64 = ([\\d_]+);`))[1].replaceAll("_", ""));

test("thresholds match math.rs", () => {
  assert.equal(XRAY_SCALE_M, rustConst("XRAY_SCALE_M"));
  assert.equal(XRAY_SCALE_X, rustConst("XRAY_SCALE_X"));
  assert.equal(KP_STORM, rustConst("KP_STORM"));
});

const calm = { mFired: false, xFired: false, stormFired: false, pendingBudget: 0n };
const r = (value) => ({ value, observedAt: 1_760_000_000 });

test("quiet Sun: nothing to do", () => {
  assert.deepEqual(decide({ xray: r(2_000), kp: r(300) }, calm), []);
});

test("M flare arms tier M with the reading", () => {
  assert.deepEqual(decide({ xray: r(23_500), kp: r(300) }, calm), [{ type: "arm", tier: TIER.M, reading: r(23_500) }]);
});

test("M that grows into X still fires X once", () => {
  const afterM = { ...calm, mFired: true };
  assert.deepEqual(decide({ xray: r(150_000), kp: r(300) }, afterM), [{ type: "arm", tier: TIER.X, reading: r(150_000) }]);
  assert.deepEqual(decide({ xray: r(150_000), kp: r(300) }, { ...afterM, xFired: true }), []);
});

test("after an X, the decaying flare does not fire M", () => {
  assert.deepEqual(decide({ xray: r(40_000), kp: r(300) }, { ...calm, mFired: true, xFired: true }), []);
});

test("G4 storm arms the storm tier", () => {
  assert.deepEqual(decide({ xray: r(2_000), kp: r(833) }, calm), [{ type: "arm", tier: TIER.Storm, reading: r(833) }]);
});

test("a pending burn blocks any new arm", () => {
  assert.deepEqual(decide({ xray: r(150_000), kp: r(900) }, { ...calm, pendingBudget: 5n }), []);
});

test("sync once the Sun is calm again", () => {
  assert.deepEqual(decide({ xray: r(2_000), kp: r(300) }, { ...calm, mFired: true }), [{ type: "sync" }]);
  assert.deepEqual(decide({ xray: r(2_000), kp: r(700) }, { ...calm, stormFired: true }), [{ type: "sync" }]);
  // Still at M level: no sync.
  assert.deepEqual(decide({ xray: r(20_000), kp: r(300) }, { ...calm, mFired: true }), []);
});

test("missing readings never arm", () => {
  assert.deepEqual(decide({ xray: null, kp: null }, calm), []);
});
