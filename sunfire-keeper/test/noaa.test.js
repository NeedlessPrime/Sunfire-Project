import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { latestKp, latestXray, readNoaa, KP_URL, XRAY_URL } from "../src/noaa.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const unix = (iso) => Date.parse(iso) / 1000;

test("X-ray: latest long-band reading, scaled ×1e9", () => {
  // 07:59 is the newest 0.1-0.8nm row. The larger 0.05-0.4nm row and the
  // older X-level row must be ignored.
  assert.deepEqual(latestXray(fixture("xrays.json")), { value: 23_500, observedAt: unix("2026-10-19T07:59:00Z") });
});

test("X-ray: empty or broken data gives null", () => {
  assert.equal(latestXray([]), null);
  assert.equal(latestXray(null), null);
  assert.equal(latestXray([{ time_tag: "2026-10-19T07:59:00Z", energy: "0.1-0.8nm", flux: null }]), null);
});

test("Kp: header-row format, latest row, ×100", () => {
  assert.deepEqual(latestKp(fixture("kp-rows.json")), { value: 767, observedAt: unix("2026-10-19T06:00:00Z") });
});

test("Kp: object format, times without Z read as UTC", () => {
  assert.deepEqual(latestKp(fixture("kp-objects.json")), { value: 800, observedAt: unix("2026-10-19T06:00:00Z") });
});

test("readNoaa fetches both feeds", async () => {
  const seen = [];
  const fetchFn = async (url) => {
    seen.push(url);
    const body = url === XRAY_URL ? fixture("xrays.json") : fixture("kp-rows.json");
    return { ok: true, json: async () => body };
  };
  const r = await readNoaa(fetchFn);
  assert.deepEqual(seen.sort(), [KP_URL, XRAY_URL].sort());
  assert.equal(r.xray.value, 23_500);
  assert.equal(r.kp.value, 767);
});

test("readNoaa throws on HTTP errors", async () => {
  await assert.rejects(readNoaa(async () => ({ ok: false, status: 503 })), /NOAA 503/);
});
