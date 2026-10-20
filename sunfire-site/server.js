// Serves the site, plus:
// - /sdo/…: the site's own copy of NASA's latest Sun images and replays. NASA's
//   server is often slow (up to half a minute before the first byte), so the copy
//   is refreshed in the background and visitors get it at once.
// - /api/replay: the time span of NASA's latest replay for a channel, so the page
//   can place NOAA flares on the replay's timeline.
// NASA's server sends no CORS headers, so the page cannot ask it directly.
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const handler = require("serve-handler");
const config = { ...require("./serve.json"), public: __dirname };

const LATEST = "https://sdo.gsfc.nasa.gov/assets/img/latest/";
const MOVIES = LATEST + "mpeg/";
const CHANNELS = new Set(["0171", "0193", "0304", "0131", "0094", "0211", "0335", "1600", "HMIB", "HMIIC"]);
const MINUTE = 60e3;
const DAY = 86400e3;
// NASA writes a replay about five minutes after its last frame, and each
// replay starts with the first image of the day two days before that frame.
const WRITE_LAG = 5 * MINUTE;
const CACHE_FOR = 5 * MINUTE;
const cache = new Map();

/* ---------- The copy of NASA's files ---------- */
// Each version is kept on disk under its own name, so a visitor still loading a
// replay keeps reading the same bytes while a newer one comes in.
const PORT = Number(process.env.PORT) || 3000;
const STORE = path.join(os.tmpdir(), "sunfire-sdo-" + PORT);
fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(STORE, { recursive: true });
const COPY = /^(?:latest_(?:512|1024|4096)_(\w+)\.jpg|mpeg\/latest_(?:512|1024)_(\w+)\.mp4)$/;
const copies = new Map();

function copyOf(name) {
  const m = COPY.exec(name);
  if (!m || !CHANNELS.has(m[1] || m[2])) return null;
  if (!copies.has(name)) copies.set(name, { name, file: null, size: 0, modified: 0, checkedAt: 0, askedAt: 0, pending: null });
  return copies.get(name);
}
// NASA updates its images every few minutes and its replays a few times a day.
const stale = (c) => Date.now() - c.checkedAt > (c.name.endsWith(".mp4") ? 10 : 3) * MINUTE;

// Asks NASA for anything newer than the copy. When the copy is current NASA
// answers 304, which costs almost nothing.
async function fetchCopy(c) {
  try {
    const headers = c.modified ? { "if-modified-since": new Date(c.modified).toUTCString() } : {};
    const res = await fetch(LATEST + c.name, { headers, signal: AbortSignal.timeout(15 * MINUTE) });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`NASA answered ${res.status}`);
    const modified = Date.parse(res.headers.get("last-modified")) || Date.now();
    if (c.file && modified <= c.modified) return void res.body?.cancel();
    let body = Buffer.from(await res.arrayBuffer());
    if (c.name.endsWith(".mp4")) body = faststart(body);
    const file = path.join(STORE, c.name.replace("/", "_") + "." + modified);
    await fs.promises.writeFile(file, body);
    const old = c.file;
    Object.assign(c, { file, size: body.length, modified });
    if (old) setTimeout(() => fs.promises.unlink(old).catch(() => {}), 10 * MINUTE);
  } catch (e) {
    console.warn(`NASA ${c.name}: ${e.message}`);
  }
}
function update(c) {
  c.pending ||= fetchCopy(c).finally(() => { c.checkedAt = Date.now(); c.pending = null; });
  return c.pending;
}

// NASA's replays keep their index (the moov box) after the frames, so a browser
// has to reach the end of the file before it can show anything. The copy has it
// moved to the front: a replay starts as soon as its first frames arrive.
function faststart(buf) {
  const boxes = [];
  for (let at = 0; at + 8 <= buf.length; ) {
    let size = buf.readUInt32BE(at);
    if (size === 1) size = Number(buf.readBigUInt64BE(at + 8));
    else if (size === 0) size = buf.length - at;
    if (size < 8 || at + size > buf.length) return buf;
    boxes.push({ type: buf.toString("latin1", at + 4, at + 8), at, size });
    at += size;
  }
  const moov = boxes.find((b) => b.type === "moov"), mdat = boxes.find((b) => b.type === "mdat");
  if (!moov || !mdat || moov.at < mdat.at) return buf;
  const index = Buffer.from(buf.subarray(moov.at, moov.at + moov.size));
  if (!shiftOffsets(index, buf.readUInt32BE(moov.at) === 1 ? 16 : 8, index.length, moov.size)) return buf;
  const rest = boxes.filter((b) => b !== moov).map((b) => buf.subarray(b.at, b.at + b.size));
  const i = boxes.filter((b) => b !== moov).indexOf(mdat);
  return Buffer.concat([...rest.slice(0, i), index, ...rest.slice(i)]);
}
// The chunk offsets (stco, co64) point into the file, so they move with the frames.
function shiftOffsets(buf, from, to, by) {
  for (let at = from; at + 8 <= to; ) {
    const size = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8);
    if (size < 8 || at + size > to) return false;
    if (["moov", "trak", "mdia", "minf", "stbl"].includes(type) && !shiftOffsets(buf, at + 8, at + size, by)) return false;
    if (type === "stco" || type === "co64") {
      const wide = type === "co64";
      for (let k = 0, n = buf.readUInt32BE(at + 12); k < n; k++) {
        const p = at + 16 + k * (wide ? 8 : 4);
        if (wide) { buf.writeBigUInt64BE(buf.readBigUInt64BE(p) + BigInt(by), p); continue; }
        const v = buf.readUInt32BE(p) + by;
        if (v > 0xffffffff) return false;
        buf.writeUInt32BE(v, p);
      }
    }
    at += size;
  }
  return true;
}

// Sends the copy, by byte ranges for the replays. Before the first copy is in,
// the visitor is sent to NASA, as before.
function sendCopy(req, res, c) {
  c.askedAt = Date.now();
  if (stale(c)) update(c);
  if (!c.file) { res.writeHead(302, { location: LATEST + c.name, "cache-control": "no-store" }); return res.end(); }
  const etag = `"${c.modified.toString(36)}-${c.size.toString(36)}"`;
  const headers = {
    "content-type": c.name.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
    "accept-ranges": "bytes", etag, "last-modified": new Date(c.modified).toUTCString(), "cache-control": "public, max-age=120",
  };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); return res.end(); }
  let start = 0, end = c.size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] || range[2]) && (!req.headers["if-range"] || req.headers["if-range"] === etag)) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
    else start = Math.max(0, c.size - Number(range[2]));
    if (start > end) { res.writeHead(416, { "content-range": `bytes */${c.size}` }); return res.end(); }
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${c.size}`;
  }
  headers["content-length"] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(c.file, { start, end }).on("error", () => res.destroy()).pipe(res);
}

// Files asked for in the last day stay fresh, so the next visitor never waits for
// NASA. The latest image of every channel and the default replay are fetched as
// soon as the server starts.
setInterval(() => { for (const c of copies.values()) if (Date.now() - c.askedAt < DAY && stale(c)) update(c); }, MINUTE);
for (const name of ["mpeg/latest_512_0171.mp4", "mpeg/latest_1024_0171.mp4", ...["0171", "0304", "0193", "0131", "0094", "0211", "HMIB", "HMIIC"].map((ch) => `latest_1024_${ch}.jpg`)]) {
  const c = copyOf(name);
  c.askedAt = Date.now();
  update(c);
}

/* ---------- Replay time span ---------- */
async function replaySpan(chan, size) {
  const copy = copies.get(`mpeg/latest_${size}_${chan}.mp4`);
  let written = copy?.file ? copy.modified : null;
  if (!written) {
    const hit = cache.get(chan);
    if (hit && Date.now() - hit.at < CACHE_FOR) return hit.span;
    const res = await fetch(`${MOVIES}latest_1024_${chan}.mp4`, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    written = Date.parse(res.headers.get("last-modified"));
    if (!res.ok || !Number.isFinite(written)) throw new Error(`NASA answered ${res.status}`);
  }
  const end = written - WRITE_LAG;
  const start = Math.floor(end / DAY) * DAY - 2 * DAY;
  const span = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  if (!copy?.file) cache.set(chan, { at: Date.now(), span });
  return span;
}

function json(res, status, body, maxAge = 0) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const copy = url.pathname.startsWith("/sdo/") && copyOf(url.pathname.slice(5));
  if (copy) return sendCopy(req, res, copy);
  if (url.pathname !== "/api/replay") return handler(req, res, config);
  const chan = url.searchParams.get("chan");
  if (!CHANNELS.has(chan)) return json(res, 400, { error: "unknown channel" });
  try {
    json(res, 200, await replaySpan(chan, url.searchParams.get("size") === "512" ? 512 : 1024), 60);
  } catch (e) {
    json(res, 502, { error: "NASA unreachable" });
  }
}).listen(PORT, "0.0.0.0", () => console.log(`SunFire site on port ${PORT}`));
