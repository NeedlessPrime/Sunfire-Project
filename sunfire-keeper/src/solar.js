// Solar events for the bot-only mode, read from NOAA SWPC lists that give
// every flare and storm a stable identity, so the bot can burn exactly once
// per event without any on-chain state.

const BASE = "https://services.swpc.noaa.gov";
export const FLARES_7DAY_URL = `${BASE}/json/goes/primary/xray-flares-7-day.json`;
export const FLARES_LATEST_URL = `${BASE}/json/goes/primary/xray-flares-latest.json`;
export const KP_URL = `${BASE}/products/noaa-planetary-k-index.json`;

/** Share of the bot wallet spent per event, as an inclusive bps range. Same as math.rs. */
export const RANGES = { M: [100, 500], X: [1_000, 2_500], Storm: [3_000, 5_000] };
export const KP_STORM = 8;

const RANK = { A: 0, B: 1, C: 2, M: 3, X: 4 };

/**
 * M and X flares that began within `maxAgeSec`. A flare that reached X gives
 * an X event only; one that is still at M gives an M event, and a later X for
 * the same flare is a separate event. Same rule as the program's Episode.
 */
export function flareEvents(rows, nowSec, maxAgeSec) {
  const byBegin = new Map();
  for (const r of rows) {
    const begin = toUnix(r?.begin_time);
    if (begin === null) continue;
    const cls = [r.max_class, r.current_class].filter(isClass).sort(byRank).pop();
    if (!cls) continue;
    const prev = byBegin.get(begin);
    if (!prev || byRank(prev.cls, cls) < 0) byBegin.set(begin, { cls, beginTag: r.begin_time });
  }
  const events = [];
  for (const [begin, { cls, beginTag }] of byBegin) {
    if (nowSec - begin > maxAgeSec || begin > nowSec + 300) continue;
    const tier = cls[0] === "X" ? "X" : cls[0] === "M" ? "M" : null;
    if (!tier) continue;
    events.push({ key: `${tier}-${isoMinute(begin)}`, tier, label: `${cls} flare`, observedAt: begin, noaa: `${cls} begin ${beginTag}` });
  }
  return events.sort((a, b) => a.observedAt - b.observedAt);
}

/**
 * The current or latest G4+ storm: a run of consecutive Kp periods ≥ 8 whose
 * last period is within `maxAgeSec`. The storm is named after its first period.
 */
export function stormEvents(kpData, nowSec, maxAgeSec) {
  const rows = kpRows(kpData);
  const events = [];
  let start = null;
  for (let i = 0; i < rows.length; i++) {
    const { t, kp } = rows[i];
    if (kp >= KP_STORM) {
      if (start === null) start = rows[i];
      const last = i === rows.length - 1 || rows[i + 1].kp < KP_STORM;
      if (last && nowSec - t <= maxAgeSec) {
        events.push({ key: `G4-${isoMinute(start.t)}`, tier: "Storm", label: `G4+ storm (Kp ${kp})`, observedAt: t, noaa: `Kp ${kp} at ${new Date(t * 1000).toISOString()}` });
      }
    } else {
      start = null;
    }
  }
  return events;
}

export async function readSolarEvents({ fetchFn = fetch, nowSec, maxAgeSec }) {
  const [week, latest, kp] = await Promise.all([FLARES_7DAY_URL, FLARES_LATEST_URL, KP_URL].map((u) => getJson(fetchFn, u)));
  const flares = [...(Array.isArray(week) ? week : []), ...(Array.isArray(latest) ? latest : [])];
  return [...flareEvents(flares, nowSec, maxAgeSec), ...stormEvents(kp, nowSec, maxAgeSec)].sort((a, b) => a.observedAt - b.observedAt);
}

/** Picks a share in the tier's range from 32 random bytes, like math::random_bps. */
export function randomBps(tier, seed) {
  const [lo, hi] = RANGES[tier];
  return lo + Number(Buffer.from(seed).readBigUInt64LE(0) % BigInt(hi - lo + 1));
}

function kpRows(data) {
  if (!Array.isArray(data) || data.length === 0) return [];
  let rows = data;
  if (Array.isArray(data[0])) {
    const [header, ...rest] = data;
    const ti = header.indexOf("time_tag");
    const ki = header.indexOf("Kp");
    if (ti < 0 || ki < 0) return [];
    rows = rest.map((r) => ({ time_tag: r[ti], Kp: r[ki] }));
  }
  return rows
    .map((r) => ({ t: toUnix(r?.time_tag), kp: Number(r?.Kp ?? r?.kp) }))
    .filter((r) => r.t !== null && Number.isFinite(r.kp))
    .sort((a, b) => a.t - b.t);
}

const isClass = (c) => typeof c === "string" && /^[ABCMX]\d/.test(c);
function byRank(a, b) {
  return RANK[a[0]] - RANK[b[0]] || parseFloat(a.slice(1)) - parseFloat(b.slice(1));
}
const isoMinute = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace(/[-:]/g, "");

async function getJson(fetchFn, url) {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`NOAA ${res.status} for ${url}`);
  return res.json();
}

// NOAA mixes "2026-10-19T08:00:00Z" and "2026-10-19 06:00:00.000", both UTC.
function toUnix(tag) {
  if (typeof tag !== "string") return null;
  const ms = Date.parse(tag.replace(" ", "T").replace(/Z?$/, "Z"));
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
