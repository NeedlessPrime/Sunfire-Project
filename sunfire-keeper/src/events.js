// Mirrors programs/sunfire/src/math.rs, so the bot only sends transactions
// the program will accept. test/events.test.js checks the constants.

export const XRAY_SCALE_M = 10_000;
export const XRAY_SCALE_X = 100_000;
export const KP_STORM = 800;

export const TIER = { M: 0, X: 1, Storm: 2 };
export const TIER_NAME = ["M", "X", "Storm"];

/**
 * What the keeper should do with the latest readings.
 * Returns at most one arm (a pending burn blocks the next one) and a sync
 * when a fired trigger can be re-armed.
 */
export function decide({ xray, kp }, state) {
  const actions = [];
  const calmXray = xray && xray.value < XRAY_SCALE_M;
  const calmKp = kp && kp.value < KP_STORM;
  if ((calmXray && (state.mFired || state.xFired)) || (calmKp && state.stormFired)) {
    actions.push({ type: "sync" });
  }
  if (state.pendingBudget > 0n) return actions;

  if (xray && xray.value >= XRAY_SCALE_X && !state.xFired) {
    actions.push({ type: "arm", tier: TIER.X, reading: xray });
  } else if (kp && kp.value >= KP_STORM && !state.stormFired) {
    actions.push({ type: "arm", tier: TIER.Storm, reading: kp });
  } else if (xray && xray.value >= XRAY_SCALE_M && !state.mFired && !state.xFired) {
    actions.push({ type: "arm", tier: TIER.M, reading: xray });
  }
  return actions;
}
