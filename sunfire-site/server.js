// Serves the site, plus /api/replay: the time span of NASA's latest replay
// for a channel, so the page can place NOAA flares on the replay's timeline.
// NASA's server sends no CORS headers, so the page cannot ask it directly.
const http = require("node:http");
const handler = require("serve-handler");
const config = { ...require("./serve.json"), public: __dirname };

const MOVIES = "https://sdo.gsfc.nasa.gov/assets/img/latest/mpeg/";
const CHANNELS = new Set(["0171", "0193", "0304", "0131", "0094", "0211", "0335", "1600", "HMIB", "HMIIC"]);
const DAY = 86400e3;
// NASA writes a replay about five minutes after its last frame, and each
// replay starts with the first image of the day two days before that frame.
const WRITE_LAG = 5 * 60e3;
const CACHE_FOR = 5 * 60e3;
const cache = new Map();

async function replaySpan(chan) {
  const hit = cache.get(chan);
  if (hit && Date.now() - hit.at < CACHE_FOR) return hit.span;
  const res = await fetch(`${MOVIES}latest_1024_${chan}.mp4`, { method: "HEAD", signal: AbortSignal.timeout(8000) });
  const written = Date.parse(res.headers.get("last-modified"));
  if (!res.ok || !Number.isFinite(written)) throw new Error(`NASA answered ${res.status}`);
  const end = written - WRITE_LAG;
  const start = Math.floor(end / DAY) * DAY - 2 * DAY;
  const span = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  cache.set(chan, { at: Date.now(), span });
  return span;
}

function json(res, status, body, maxAge = 0) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/api/replay") return handler(req, res, config);
  const chan = url.searchParams.get("chan");
  if (!CHANNELS.has(chan)) return json(res, 400, { error: "unknown channel" });
  try {
    json(res, 200, await replaySpan(chan), CACHE_FOR / 1000);
  } catch (e) {
    json(res, 502, { error: "NASA unreachable" });
  }
}).listen(Number(process.env.PORT) || 3000, "0.0.0.0", () => console.log(`SunFire site on port ${Number(process.env.PORT) || 3000}`));
