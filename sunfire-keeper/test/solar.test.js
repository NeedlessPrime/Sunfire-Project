import { test } from "node:test";
import assert from "node:assert/strict";
import { flareEvents, randomBps, RANGES, stormEvents } from "../src/solar.js";

const t = (iso) => Math.floor(Date.parse(iso) / 1000);
const NOW = t("2026-10-19T18:00:00Z");
const SIX_H = 6 * 3600;
const flare = (begin, max, current) => ({ begin_time: begin, max_class: max, ...(current ? { current_class: current } : {}) });

test("C flares give no event, M and X flares do", () => {
  const ev = flareEvents([
    flare("2026-10-19T12:00:00Z", "C9.9"),
    flare("2026-10-19T13:00:00Z", "M1.0"),
    flare("2026-10-19T14:00:00Z", "X2.1"),
  ], NOW, SIX_H);
  assert.deepEqual(ev.map((e) => [e.tier, e.key]), [["M", "M-20261019T1300"], ["X", "X-20261019T1400"]]);
  assert.equal(ev[1].noaa, "X2.1 begin 2026-10-19T14:00:00Z");
});

test("the same flare in both NOAA lists is one event, at its highest class", () => {
  const ev = flareEvents([
    flare("2026-10-19T15:00:00Z", "M4.0"),
    { ...flare("2026-10-19T15:00:00Z", "M6.0", "X1.2"), time_tag: "2026-10-19T15:20:00Z" },
  ], NOW, SIX_H);
  assert.deepEqual(ev.map((e) => e.key), ["X-20261019T1500"]);
  assert.equal(ev[0].label, "X1.2 flare");
});

test("an M flare that grows into an X gets a second, different key", () => {
  const early = flareEvents([flare("2026-10-19T16:00:00Z", "M3.0")], NOW, SIX_H)[0];
  const later = flareEvents([flare("2026-10-19T16:00:00Z", "X1.0")], NOW, SIX_H)[0];
  assert.notEqual(early.key, later.key);
});

test("flares older than the window or in the future are ignored", () => {
  const ev = flareEvents([flare("2026-10-19T11:59:00Z", "X5.0"), flare("2026-10-19T19:00:00Z", "M1.0")], NOW, SIX_H);
  assert.deepEqual(ev, []);
});

test("a G4+ storm is one event named after its first Kp ≥ 8 period", () => {
  const rows = [
    { time_tag: "2026-10-19T06:00:00", Kp: 7.67 },
    { time_tag: "2026-10-19T09:00:00", Kp: 8.0 },
    { time_tag: "2026-10-19T12:00:00", Kp: 8.67 },
    { time_tag: "2026-10-19T15:00:00", Kp: 8.33 },
  ];
  const ev = stormEvents(rows, NOW, SIX_H);
  assert.deepEqual(ev.map((e) => [e.tier, e.key]), [["Storm", "G4-20261019T0900"]]);
});

test("Kp header-row format and a storm that ended long ago", () => {
  const rows = [["time_tag", "Kp"], ["2026-10-18 00:00:00.000", "8.33"], ["2026-10-18 03:00:00.000", "5.00"]];
  assert.deepEqual(stormEvents(rows, NOW, SIX_H), []);
  assert.equal(stormEvents(rows, t("2026-10-18T04:00:00Z"), SIX_H).length, 1);
});

test("random share stays in each tier's range", () => {
  for (const tier of Object.keys(RANGES)) {
    const [lo, hi] = RANGES[tier];
    for (let i = 0; i < 256; i++) {
      const bps = randomBps(tier, Buffer.alloc(32, i));
      assert.ok(bps >= lo && bps <= hi, `${tier} ${bps}`);
    }
  }
});
