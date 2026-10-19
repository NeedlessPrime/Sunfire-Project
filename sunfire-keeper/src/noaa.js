// NOAA SWPC feeds. Values are scaled the same way as the program:
// X-ray flux in W/m² × 1e9 (M1.0 = 10_000), Kp × 100 (Kp 8 = 800).

const BASE = "https://services.swpc.noaa.gov";
export const XRAY_URL = `${BASE}/json/goes/primary/xrays-6-hour.json`;
export const KP_URL = `${BASE}/products/noaa-planetary-k-index.json`;

/** Latest long-band (0.1–0.8 nm) X-ray reading, or null. */
export function latestXray(rows) {
  let best = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.energy !== "0.1-0.8nm" || typeof r.flux !== "number" || r.flux <= 0) continue;
    const t = toUnix(r.time_tag);
    if (t !== null && (!best || t > best.observedAt)) best = { value: Math.floor(r.flux * 1e9), observedAt: t };
  }
  return best;
}

/** Latest planetary Kp, from either the object or the header-row format. */
export function latestKp(data) {
  if (!Array.isArray(data) || data.length === 0) return null;
  let rows = data;
  if (Array.isArray(data[0])) {
    const [header, ...rest] = data;
    const ti = header.indexOf("time_tag");
    const ki = header.indexOf("Kp");
    if (ti < 0 || ki < 0) return null;
    rows = rest.map((r) => ({ time_tag: r[ti], Kp: r[ki] }));
  }
  let best = null;
  for (const r of rows) {
    const kp = Number(r?.Kp ?? r?.kp);
    const t = toUnix(r?.time_tag);
    if (!Number.isFinite(kp) || t === null) continue;
    if (!best || t > best.observedAt) best = { value: Math.round(kp * 100), observedAt: t };
  }
  return best;
}

export async function readNoaa(fetchFn = fetch) {
  const [xray, kp] = await Promise.all([getJson(fetchFn, XRAY_URL), getJson(fetchFn, KP_URL)]);
  return { xray: latestXray(xray), kp: latestKp(kp) };
}

async function getJson(fetchFn, url) {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`NOAA ${res.status} for ${url}`);
  return res.json();
}

// NOAA mixes "2026-10-19T08:00:00Z" and "2026-10-19 06:00:00.000", both UTC.
function toUnix(tag) {
  if (typeof tag !== "string") return null;
  const iso = tag.replace(" ", "T").replace(/Z?$/, "Z");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
