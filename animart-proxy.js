const http   = require("http");
const https  = require("https");
const { spawn } = require("child_process");
const url    = require("url");
const readline = require("readline");

const PORT = 7799;

// ── Supported resolution options ───────────────────────────
// Bitrate is ALWAYS high regardless of selected resolution.
// Lowering resolution only reduces dimensions, not visual quality.
// "0" = automatic bitrate (let ffmpeg choose optimal for that resolution).
const RESOLUTION_OPTIONS = {
  "360" : { label: "360p  — small size, bitrate remains high", height: 360,  bitrate: "0" },
  "480" : { label: "480p  — standard (default), full bitrate",   height: 480,  bitrate: "0" },
  "720" : { label: "720p  — HD, sharp, full bitrate",           height: 720,  bitrate: "0" },
  "1080": { label: "1080p — Full HD, maximum quality",         height: 1080, bitrate: "0" },
  "best": { label: "Best  — highest quality (auto resolution)", height: null, bitrate: "0" },
};

// ── Parse CLI arguments ──────────────────────────────────────
let selectedResolution = null;

async function pickResolution() {
  const arg = process.argv[2]?.toLowerCase()?.trim();

  if (arg && RESOLUTION_OPTIONS[arg]) {
    selectedResolution = RESOLUTION_OPTIONS[arg];
    console.log(`\n🎬 Resolution selected: ${selectedResolution.label}`);
    return;
  }

  if (arg) {
    console.warn(`\n⚠  Resolution "${arg}" not recognized. Showing menu.\n`);
  }

  // Show interactive menu
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   animart-proxy v5 — Select Artwork Resolution   ║");
  console.log("╠══════════════════════════════════════════════════╣");
  const keys = Object.keys(RESOLUTION_OPTIONS);
  keys.forEach((k, i) => {
    console.log(`║  [${i + 1}] ${RESOLUTION_OPTIONS[k].label.padEnd(43)}║`);
  });
  console.log("╚══════════════════════════════════════════════════╝");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise(resolve => {
    const ask = () => {
      rl.question("\nSelect [1-5] (Enter = 480p default): ", answer => {
        const trimmed = answer.trim();
        if (trimmed === "") {
          selectedResolution = RESOLUTION_OPTIONS["480"];
          console.log(`✓ Using default: ${selectedResolution.label}`);
          rl.close();
          resolve();
          return;
        }
        const idx = parseInt(trimmed) - 1;
        if (idx >= 0 && idx < keys.length) {
          selectedResolution = RESOLUTION_OPTIONS[keys[idx]];
          console.log(`✓ Selected: ${selectedResolution.label}`);
          rl.close();
          resolve();
        } else {
          console.log("  Invalid choice, please try again.");
          ask();
        }
      });
    };
    ask();
  });
}

// ── API Sources (3 APIs, searched in parallel) ─────────────
const API_M8TEC      = "https://artwork.m8tec.top/api/v1/artwork/search";
const ITUNES_SEARCH  = "https://itunes.apple.com/search";
const AM_LOOKUP      = "https://amp-api.music.apple.com/v1/catalog/us/albums";

// ── In-Memory Cache: m3u8 URL ─────────────────────────────
// key: "artist|album|title" → { m3u8: string|null, ts: number }
const cache = new Map();
const CACHE_TTL_MS    = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_NONE_MS   =  4 * 60 * 60 * 1000; // cache "not found" for 4 hours

// ── In-Memory Cache: transcoded WebM results ───────────────
// key: m3u8Url → { webm: Buffer, ts: number, hitCount: number }
// This prevents re-download + re-transcode for the same song.
const webmCache = new Map();
const WEBM_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // keep for 2 hours
const WEBM_CACHE_MAX    = 10;                    // max 10 songs in memory

// If cache is full, remove the oldest entry
function webmCacheSet(key, webmBuf) {
  if (webmCache.size >= WEBM_CACHE_MAX) {
    // Remove the oldest entry (first inserted)
    const oldestKey = webmCache.keys().next().value;
    webmCache.delete(oldestKey);
    console.log(`[proxy] webm cache full → removing oldest entry`);
  }
  webmCache.set(key, { webm: webmBuf, ts: Date.now(), hitCount: 0 });
  console.log(`[proxy] webm cache: saved (${(webmBuf.length / 1024).toFixed(0)} KB), total entries: ${webmCache.size}`);
}

// ── In-Flight deduplication ────────────────────────────────
// If 2 /transcode requests with the same URL arrive simultaneously
// (e.g.: NPV player + SL player request at the same time),
// the second request won't re-download — it just waits for the first promise.
// key: m3u8Url → Promise<Buffer>
const inFlight = new Map();

// ── Helper: fetch URL → Buffer ─────────────────────────────
function fetchBuf(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const proto = targetUrl.startsWith("https") ? https : http;
    const req = proto.get(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept"    : "*/*",
        ...extraHeaders,
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchBuf(res.headers.location, extraHeaders));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} → ${targetUrl.slice(0, 80)}`));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error(`Timeout (8s): ${targetUrl.slice(0, 60)}`)); });
  });
}

async function fetchText(u, headers) {
  const buf = await fetchBuf(u, headers);
  return buf.toString("utf8");
}

async function fetchJson(u, headers) {
  const text = await fetchText(u, headers);
  return JSON.parse(text);
}

// ── Sanitize query string ──────────────────────────────────
function sanitize(str) {
  if (!str) return "";
  return str
    .replace(/\$/g, "S")
    .replace(/[&+#%@=]/g, " ")
    .replace(/[^\w\s\-'.,()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── SOURCE 1: artwork.m8tec.top ───────────────────────────
async function fromM8tec(artist, album, title) {
  const attempts = [
    { artist, album, title },
    { artist: sanitize(artist), album: sanitize(album), title: sanitize(title) },
    { artist: sanitize(artist), album: "", title: sanitize(title) },
  ];
  const seen = new Set();
  const unique = attempts.filter(q => {
    const k = `${q.artist}|${q.album}|${q.title}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  for (const q of unique) {
    const params = new URLSearchParams({ artist: q.artist||"", album: q.album||"", title: q.title||"" });
    try {
      const json = await fetchJson(`${API_M8TEC}?${params}`, { Accept: "application/json" });
      const item = Array.isArray(json) ? json[0] : json;
      const m3u8 = item?.m3u8Url || item?.hlsUrl || item?.videoUrl ||
                   item?.url     || item?.hls_url || item?.stream_url ||
                   item?.variants?.[0]?.url || item?.results?.[0]?.m3u8Url || null;
      if (m3u8) { console.log(`[proxy] ✓ API-1 m8tec: "${q.title}"`); return m3u8; }
    } catch(e) { console.warn(`[proxy] API-1 m8tec failed: ${e.message}`); }
  }
  return null;
}

// ── SOURCE 2: iTunes Search → Apple Music AMP API ─────────
async function fromItunesAmp(artist, title) {
  // Step A: find collectionId via iTunes
  const queries = [
    `${title} ${artist}`,
    `${sanitize(title)} ${sanitize(artist)}`,
    sanitize(title),
  ];
  let collectionId = null;
  for (const q of queries) {
    if (!q.trim()) continue;
    try {
      const params = new URLSearchParams({ term: q, media: "music", entity: "song", limit: "5", country: "us" });
      const json   = await fetchJson(`${ITUNES_SEARCH}?${params}`);
      if (!json.results?.length) continue;
      const best = json.results.find(r =>
        r.artistName?.toLowerCase().includes(sanitize(artist).toLowerCase()) &&
        r.trackName?.toLowerCase().includes(sanitize(title).toLowerCase())
      ) || json.results.find(r =>
        r.trackName?.toLowerCase().includes(sanitize(title).toLowerCase())
      ) || json.results[0];
      if (best?.collectionId) { collectionId = best.collectionId; break; }
    } catch(e) { console.warn(`[proxy] API-2 iTunes failed: ${e.message}`); }
  }
  if (!collectionId) return null;

  // Step B: AMP API to get m3u8
  try {
    const html  = await fetchText("https://music.apple.com/", { Accept: "text/html" });
    const match = html.match(/name="desktop-music-app\/config\/environment"\s+content="([^"]+)"/);
    if (!match) throw new Error("Apple token not found");
    const config = JSON.parse(decodeURIComponent(match[1]));
    const token  = config?.MEDIA_API?.token;
    if (!token)  throw new Error("Token is empty");
    const json   = await fetchJson(`${AM_LOOKUP}/${collectionId}?include=albums`, {
      Authorization: `Bearer ${token}`,
      Origin: "https://music.apple.com",
    });
    const attrs = json?.data?.[0]?.attributes;
    const m3u8  = attrs?.editorialVideo?.motionSquareVideo1x1?.video ||
                  attrs?.editorialArtwork?.motionDetailSquare?.video ||
                  attrs?.editorialArtwork?.motionSquareVideo1x1?.video || null;
    if (m3u8) { console.log(`[proxy] ✓ API-2 iTunes+AMP: "${title}"`); return m3u8; }
  } catch(e) { console.warn(`[proxy] API-2 AMP failed: ${e.message}`); }
  return null;
}

// ── SOURCE 3: Apple Music web scraping ────────────────────
async function fromAppleScrape(artist, title) {
  // Find collectionId first via iTunes (same as source 2)
  let collectionId = null;
  try {
    const params = new URLSearchParams({
      term: `${sanitize(title)} ${sanitize(artist)}`, media: "music", entity: "song", limit: "3", country: "us"
    });
    const json = await fetchJson(`${ITUNES_SEARCH}?${params}`);
    collectionId = json.results?.[0]?.collectionId || null;
  } catch(e) { console.warn(`[proxy] API-3 iTunes search failed: ${e.message}`); }
  if (!collectionId) return null;

  // Scrape Apple Music web page
  try {
    const html = await fetchText(`https://music.apple.com/us/album/${collectionId}`, {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://music.apple.com/",
    });
    const patterns = [
      /\"contentUrl\"\s*:\s*\"([^\"]+\.m3u8[^\"]*)\"/g,
      /\"hlsUrl\"\s*:\s*\"([^\"]+\.m3u8[^\"]*)\"/g,
      /\"videoUrl\"\s*:\s*\"([^\"]+\.m3u8[^\"]*)\"/g,
      /(https:\/\/[a-z0-9\-]+\.mzstatic\.com\/[^\"'\s]+\.m3u8)/g,
      /(https:\/\/[a-z0-9\-]+\.itunes\.apple\.com\/[^\"'\s]+\.m3u8)/g,
    ];
    for (const pattern of patterns) {
      const m = pattern.exec(html);
      if (m?.[1]) { console.log(`[proxy] ✓ API-3 Apple scrape: "${title}"`); return m[1]; }
    }
  } catch(e) { console.warn(`[proxy] API-3 scrape failed: ${e.message}`); }
  return null;
}

// ── Helper: race promises that return non-null values ──────
// Run all promises in parallel. Return the first non-null value.
// Other still-running promises are left to finish on their own (not cancelled,
// but their results are ignored). This way there are no repeat requests.
function raceFirst(promises) {
  return new Promise((resolve) => {
    let settled    = 0;
    let resolved   = false;
    const total    = promises.length;
    if (total === 0) { resolve(null); return; }

    promises.forEach(p => {
      Promise.resolve(p).then(val => {
        settled++;
        if (!resolved && val != null) {
          resolved = true;
          resolve(val);   // Use the first available result
        } else if (settled === total && !resolved) {
          resolve(null);  // All done, none had a result
        }
      }).catch(() => {
        settled++;
        if (settled === total && !resolved) resolve(null);
      });
    });
  });
}

// ── Orchestrator: search 3 APIs in parallel ────────────────
// No sequential fallback — all run simultaneously.
// The first result is used immediately, others are ignored.
async function resolveM3u8(artist, album, title) {
  const cacheKey = `${sanitize(artist)}|${sanitize(album)}|${sanitize(title)}`;
  const cached   = cache.get(cacheKey);
  if (cached) {
    const age = Date.now() - cached.ts;
    const ttl = cached.m3u8 ? CACHE_TTL_MS : CACHE_NONE_MS;
    if (age < ttl) {
      console.log(`[proxy] cache hit: "${title}" → ${cached.m3u8 ? "✓" : "none"}`);
      return cached.m3u8;
    }
  }

  console.log(`[proxy] searching in parallel across 3 APIs: "${title}" — ${artist}`);

  // All three APIs run simultaneously — none wait for the others
  const m3u8 = await raceFirst([
    fromM8tec(artist, album, title),
    fromItunesAmp(artist, title),
    fromAppleScrape(artist, title),
  ]);

  cache.set(cacheKey, { m3u8: m3u8 || null, ts: Date.now() });

  if (m3u8) {
    console.log(`[proxy] ✓ Resolved: "${title}" (m3u8 found)`);
  } else {
    console.log(`[proxy] ✗ No animated artwork: "${title}"`);
  }
  return m3u8;
}

// ── Parse M3U8 → segment URLs ─────────────────────────────
// Select stream based on user-chosen resolution.
// maxSegs = 0 means fetch ALL segments (no limit).
function resolveBase(m3u8Url) {
  // Base URL = everything up to the last slash
  return m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
}

function resolveUrl(rawUrl, baseUrl) {
  // If already a full URL, use it directly
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) return rawUrl;
  // Relative: combine with base
  try {
    return new URL(rawUrl, baseUrl).href;
  } catch {
    return baseUrl + rawUrl;
  }
}

async function resolveFirstSegments(m3u8Url, maxSegs = 3) {
  const base = resolveBase(m3u8Url);
  let text;
  try {
    text = await fetchText(m3u8Url);
  } catch (e) {
    throw new Error(`Failed to fetch playlist: ${e.message} → ${m3u8Url.slice(0, 80)}`);
  }

  // Debug: show first few playlist lines for easy diagnosis
  const previewLines = text.split("\n").slice(0, 8).join(" | ");
  console.log(`[proxy] playlist preview: ${previewLines.slice(0, 200)}`);

  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  // ── Master playlist → select quality ───────────────────────
  if (text.includes("#EXT-X-STREAM-INF")) {
    const streams = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
      const bw  = parseInt(lines[i].match(/BANDWIDTH=(\d+)/)?.[1]  || "0");
      const h   = parseInt(lines[i].match(/RESOLUTION=\d+x(\d+)/)?.[1] || "0");
      // Next line can be URI= inside the same tag, or a separate line
      let uriLine = lines[i + 1];
      // Sometimes URI is in the tag itself: URI="..."
      const uriInTag = lines[i].match(/URI="([^"]+)"/)?.[1];
      if (uriInTag) uriLine = uriInTag;
      if (!uriLine || uriLine.startsWith("#")) continue;
      const u = resolveUrl(uriLine, base);
      streams.push({ bw, h, u });
    }

    if (streams.length === 0) {
      throw new Error(`Master playlist contains no valid streams: ${m3u8Url.slice(0, 80)}`);
    }

    let chosen;
    const res = selectedResolution;
    if (!res || res.height === null) {
      streams.sort((a, b) => b.bw - a.bw);
      chosen = streams[0];
      console.log(`[proxy] master: selecting best quality (${chosen.h}p, ${chosen.bw}bps)`);
    } else {
      // Pick the closest to target height; if tied, prefer higher bandwidth
      streams.sort((a, b) => {
        const diffA = Math.abs(a.h - res.height);
        const diffB = Math.abs(b.h - res.height);
        if (diffA !== diffB) return diffA - diffB;
        return b.bw - a.bw; // same distance → prefer higher bandwidth
      });
      chosen = streams[0];
      console.log(`[proxy] master: selecting ${chosen.h}p (target: ${res.height}p, bw: ${chosen.bw})`);
    }

    console.log(`[proxy] media playlist URL: ${chosen.u.slice(0, 100)}`);
    return resolveFirstSegments(chosen.u, maxSegs);
  }

  // ── Media playlist → collect all segments ──────────────────
  // A segment is a line that:
  //   1. Does not start with "#"
  //   2. Is not an empty line
  //   3. Looks like a URL or path (contains "/", ".", or "?")
  const segs = lines
    .filter(l => !l.startsWith("#") && (l.includes("/") || l.includes(".") || l.includes("?")))
    .map(l => resolveUrl(l, base));

  console.log(`[proxy] media playlist: ${segs.length} segments found`);
  if (segs.length > 0) {
    console.log(`[proxy] seg[0]: ${segs[0].slice(0, 100)}`);
    console.log(`[proxy] seg[last]: ${segs[segs.length - 1].slice(0, 100)}`);
  } else {
    console.warn(`[proxy] ⚠ No segments found! Raw lines: ${lines.slice(0, 10).join(" | ")}`);
  }

  // maxSegs = 0 means take ALL — don't use slice(0,0)!
  return maxSegs > 0 ? segs.slice(0, maxSegs) : segs;
}

// ── GPU Auto-Detect ────────────────────────────────────────
// Detect the best GPU for H.264 hardware decoding.
// On dual-GPU systems (dedicated + integrated), use the dedicated GPU
// (NVIDIA/AMD) for decoding — faster and doesn't block the IGP.
// VP8/VP9 encoding always on CPU (libvpx) because GPU doesn't support WebM output.
//
// "Using 2 GPUs" here means:
//   - Dedicated GPU  → decode H.264 (heavy, suited for powerful GPUs)
//   - CPU (lightened by GPU decode) → encode WebM (cannot be offloaded to GPU)
//   - Integrated GPU → not used for transcoding (no benefit)
let gpuDecoder = null; // null = not yet detected, false = CPU only

async function detectGpuDecoder() {
  const hwaccels = await new Promise(resolve => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-hwaccels"]);
    let out = "";
    ff.stdout.on("data", d => out += d);
    ff.stderr.on("data", d => out += d);
    ff.on("close", () => resolve(out.toLowerCase()));
    ff.on("error", () => resolve(""));
  });

  const decoders = await new Promise(resolve => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-decoders"]);
    let out = "";
    ff.stdout.on("data", d => out += d);
    ff.stderr.on("data", d => out += d);
    ff.on("close", () => resolve(out.toLowerCase()));
    ff.on("error", () => resolve(""));
  });

  // Priority: NVIDIA (fastest) → Intel QSV → AMD/Intel D3D11VA → Mac → CPU
  // Use only ONE best GPU for decoding — no need to split encoding.
  if (decoders.includes("h264_cuvid") && hwaccels.includes("cuda")) {
    return { decoder: "h264_cuvid", hwaccel: "cuda",        label: "NVIDIA CUDA (cuvid)" };
  }
  if (decoders.includes("h264_qsv") && hwaccels.includes("qsv")) {
    return { decoder: "h264_qsv",   hwaccel: "qsv",         label: "Intel Quick Sync (QSV)" };
  }
  if (hwaccels.includes("d3d11va")) {
    return { decoder: "h264",       hwaccel: "d3d11va",     label: "AMD/Intel D3D11VA" };
  }
  if (hwaccels.includes("videotoolbox")) {
    return { decoder: "h264",       hwaccel: "videotoolbox",label: "Apple VideoToolbox (Mac)" };
  }

  return false; // No GPU decoder → CPU only
}

// ── Encoder detection ─────────────────────────────────────
// Detect whether VP9 or VP8 is available in this ffmpeg build.
// ffmpeg on Windows sometimes doesn't include libvpx-vp9 (only libvpx/VP8).
let availableEncoder = null; // will be set at startup

async function detectEncoder() {
  const encoders = await new Promise(resolve => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-encoders"]);
    let out = "";
    ff.stdout.on("data", d => out += d);
    ff.stderr.on("data", d => out += d);
    ff.on("close", () => resolve(out.toLowerCase()));
    ff.on("error", () => resolve(""));
  });

  if (encoders.includes("libvpx-vp9")) {
    console.log("✅ VP9 encoder (libvpx-vp9) available");
    return "vp9";
  } else if (encoders.includes("libvpx")) {
    console.log("⚠️  libvpx-vp9 not available → using VP8 (libvpx)");
    return "vp8";
  } else {
    console.log("⚠️  No VP8/VP9 encoder → trying libvpx as fallback");
    return "vp8"; // try anyway, ffmpeg will error on its own if unavailable
  }
}

// ── Transcode TS → WebM (VP9 if available, VP8 fallback) ──
// Dual-GPU mode: split segments into 2 batches, encode in parallel with 2 ffmpeg processes.
// Bitrate: ALWAYS full — CRF mode, uncapped.

function buildFfmpegArgs(gpu, height, encoder) {
  const args = ["-loglevel", "error"];
  const vfFilter = height ? `scale=-2:${height}` : null;

  // ── Hardware decode ────────────────────────────────────────
  if (gpu) {
    if (gpu.hwaccel === "cuda") {
      args.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
      args.push("-c:v", "h264_cuvid");
    } else if (gpu.hwaccel === "d3d11va") {
      args.push("-hwaccel", "d3d11va");
    } else if (gpu.hwaccel === "qsv") {
      args.push("-hwaccel", "qsv", "-c:v", "h264_qsv");
    } else if (gpu.hwaccel === "videotoolbox") {
      args.push("-hwaccel", "videotoolbox");
    }
  }

  // Use all available CPU threads
  const cpuThreads = Math.max(1, (require("os").cpus().length));
  args.push("-threads", String(cpuThreads));

  args.push("-i", "pipe:0");

  // ── Scale filter ───────────────────────────────────────────
  if (gpu?.hwaccel === "cuda") {
    const f = height
      ? `hwdownload,format=nv12,scale=-2:${height}`
      : "hwdownload,format=nv12";
    args.push("-vf", f);
  } else if (vfFilter) {
    args.push("-vf", vfFilter);
  }

  // ── Encoder ────────────────────────────────────────────────
  // Priority: HIGH SPEED, while keeping quality good for animated artwork.
  // Animated artwork = short loop (≤30 seconds), not a full-length film.
  // No need for very low CRF — VP8/VP9 quality 33-40 is already visually excellent.

  if (encoder === "vp9") {
    args.push(
      "-c:v",           "libvpx-vp9",
      "-deadline",      "realtime",  // FASTEST — much faster than "good"
      "-cpu-used",      "8",         // VP9 realtime max speed (0-8, 8=fastest)
      "-crf",           "33",        // very good quality, much faster encode
      "-b:v",           "2M",        // target bitrate as upper bound
      "-row-mt",        "1",         // multi-thread per row
      "-tile-columns",  "4",         // more tiles = more parallel
      "-tile-rows",     "1",
      "-frame-parallel","1",
      "-threads",       String(cpuThreads)
    );
  } else {
    // VP8 — use explicit bitrate, much faster than pure CRF mode
    args.push(
      "-c:v",      "libvpx",
      "-quality",  "realtime",  // realtime mode = fast encode
      "-cpu-used", "5",         // VP8: 0=slow/good, 16=fast/bad — 5 = sweet spot
      "-b:v",      "2M",        // target bitrate 2Mbps — more than enough for artwork
      "-maxrate",  "4M",        // upper limit
      "-bufsize",  "8M",
      "-threads",  String(cpuThreads)
    );
  }

  args.push(
    "-an",         // no audio needed
    "-f", "webm",
    "pipe:1"
  );

  return args;
}

// Run 1 ffmpeg process with input buffer data
// Handle stdin EPIPE (occurs if ffmpeg crashes before finishing reading input)
function runFfmpeg(ffArgs, inputBuf) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ffArgs);
    const chunks = [];

    ff.stdout.on("data", c => chunks.push(c));
    ff.stderr.on("data", d => process.stderr.write("[ffmpeg] " + d));

    ff.on("close", code => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exit ${code} (output: ${chunks.length} chunks)`));
      }
    });

    ff.on("error", err => {
      if (err.code === "ENOENT") {
        reject(new Error("ffmpeg not found in PATH!\nInstall: winget install ffmpeg"));
      } else {
        reject(err);
      }
    });

    // Handle EPIPE: if ffmpeg crashes, stdin.write will throw "write EOF"
    // Add handler to prevent crashing the entire Node.js process
    ff.stdin.on("error", err => {
      if (err.code === "EPIPE" || err.code === "EOF") {
        // ffmpeg already closed stdin (possible crash) — let the 'close' event handle it
        console.warn("[proxy] stdin EPIPE — waiting for ffmpeg close event...");
      } else {
        reject(err);
      }
    });

    try {
      ff.stdin.write(inputBuf);
      ff.stdin.end();
    } catch (e) {
      console.warn("[proxy] stdin write error (ignored, waiting for close):", e.message);
    }
  });
}

function transcodeTS(tsBufs, _forceNoGpu, _forceVp8) {
  const res      = selectedResolution;
  const height   = res?.height ?? null;
  const combined = Buffer.concat(tsBufs);

  // Determine GPU and encoder to use for this attempt
  const useGpu     = _forceNoGpu ? null : (gpuDecoder || null);
  const useEncoder = _forceVp8   ? "vp8" : availableEncoder;
  const ffArgs     = buildFfmpegArgs(useGpu, height, useEncoder);

  const gpuLabel     = useGpu ? useGpu.label : "CPU";
  const encoderLabel = useEncoder === "vp9" ? "VP9" : "VP8";
  console.log(`[proxy] transcode: decode=${gpuLabel}, encode=${encoderLabel}`);

  return runFfmpeg(ffArgs, combined).catch(async err => {
    // Fallback 1: GPU decode failed → try CPU decode (save state, avoid loop)
    if (useGpu && !_forceNoGpu) {
      console.warn(`[proxy] ⚠ GPU decode failed: ${err.message}`);
      console.warn(`[proxy] → Fallback: CPU decode + ${encoderLabel}`);
      gpuDecoder = false; // don't try GPU again for this session
      return transcodeTS(tsBufs, true, _forceVp8);
    }
    // Fallback 2: VP9 encode failed → try VP8
    if (useEncoder === "vp9" && !_forceVp8) {
      console.warn(`[proxy] ⚠ VP9 encode failed: ${err.message}`);
      console.warn(`[proxy] → Fallback: CPU decode + VP8`);
      availableEncoder = "vp8"; // use VP8 for all subsequent requests
      return transcodeTS(tsBufs, true, true);
    }
    // No more fallbacks
    throw new Error(`Transcode completely failed: ${err.message}`);
  });
}

// ── HTTP Server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);

  // ── GET /ping ──────────────────────────────────────────
  if (parsed.pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: "v6",
      resolution: selectedResolution?.label || "original resolution (full quality)",
      bitrate: "full (CRF mode — uncapped)",
      decode: gpuDecoder ? `GPU: ${gpuDecoder.label}` : "CPU only",
      encode: availableEncoder === "vp9" ? "libvpx-vp9 (VP9, CRF 18)" : "libvpx (VP8, CRF 4)",
      sources: ["m8tec", "iTunes+AMP", "Apple-scrape"],
      cache: {
        m3u8_entries : cache.size,
        webm_entries : webmCache.size,
        webm_max     : WEBM_CACHE_MAX,
      },
    }));
    return;
  }

  // ── GET /artwork?artist=&album=&title= ─────────────────
  if (parsed.pathname === "/artwork") {
    const { artist = "", album = "", title = "" } = parsed.query;
    if (!artist && !title) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing artist or title" }));
      return;
    }
    try {
      const m3u8 = await resolveM3u8(artist, album, title);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ m3u8: m3u8 || null }));
    } catch(e) {
      console.error("[proxy] /artwork error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /transcode?url=<m3u8> ─────────────────────────
  if (parsed.pathname === "/transcode") {
    const m3u8Url = parsed.query.url;
    if (!m3u8Url) {
      res.writeHead(400); res.end("Missing ?url="); return;
    }

    try {
      // ── 1. Check WebM cache first ───────────────────────
      const cached = webmCache.get(m3u8Url);
      if (cached && (Date.now() - cached.ts) < WEBM_CACHE_TTL_MS) {
        cached.hitCount++;
        // Log only on first hit — stay silent after that to avoid console spam
        if (cached.hitCount === 1) {
          console.log(`[proxy] ✓ webm cache active (${(cached.webm.length / 1024).toFixed(0)} KB) — subsequent requests will be silent`);
        }
        res.writeHead(200, {
          "Content-Type"  : "video/webm",
          "Content-Length": cached.webm.length,
          "Cache-Control" : "no-store",
          "X-Cache"       : "HIT",
        });
        res.end(cached.webm);
        return;
      }

      // ── 2. De-duplicate: if in-flight, wait for its result ──
      if (inFlight.has(m3u8Url)) {
        console.log(`[proxy] duplicate request — waiting for ongoing process...`);
        const webm = await inFlight.get(m3u8Url);
        res.writeHead(200, {
          "Content-Type"  : "video/webm",
          "Content-Length": webm.length,
          "Cache-Control" : "no-store",
          "X-Cache"       : "DEDUP",
        });
        res.end(webm);
        return;
      }

      // ── 3. New process: download + transcode ────────────
      console.log(`[proxy] transcode: ${m3u8Url.slice(0, 80)}...`);

      const transcodePromise = (async () => {
        const t0 = Date.now();

        // Fetch all segments (0 = unlimited) so video is not cut short
        const segs = await resolveFirstSegments(m3u8Url, 0);
        console.log(`[proxy] ${segs.length} segments found (resolve: ${Date.now()-t0}ms)`);

        // Guard: if no segments found, stop before calling ffmpeg
        if (segs.length === 0) {
          throw new Error("No segments found in playlist — format may be unsupported or URL expired");
        }

        // Download all segments in PARALLEL
        const t1 = Date.now();
        console.log(`[proxy] downloading ${segs.length} segments in parallel...`);
        const tsBufs = await Promise.all(
          segs.map((seg, i) =>
            fetchBuf(seg).then(buf => {
              process.stdout.write(`[proxy] seg ${i + 1}/${segs.length} ✓ ${(buf.length/1024).toFixed(0)}KB\n`);
              return buf;
            })
          )
        );
        const totalBytes = tsBufs.reduce((s, b) => s + b.length, 0);
        console.log(`[proxy] download complete: ${(totalBytes/1024).toFixed(0)} KB total (${Date.now()-t1}ms)`);

        if (totalBytes === 0) {
          throw new Error("All segments are empty (0 bytes) — content cannot be transcoded");
        }

        const t2 = Date.now();
        const encoderLabel = availableEncoder === "vp9" ? "VP9" : "VP8";
        console.log(`[proxy] transcoding H.264 → WebM ${encoderLabel}...`);
        const webm = await transcodeTS(tsBufs);
        console.log(`[proxy] transcode complete: ${(webm.length/1024).toFixed(0)} KB (${Date.now()-t2}ms)`);
        console.log(`[proxy] total time: ${Date.now()-t0}ms`);
        return webm;
      })();

      // Register to in-flight before await
      inFlight.set(m3u8Url, transcodePromise);

      let webm;
      try {
        webm = await transcodePromise;
      } finally {
        inFlight.delete(m3u8Url); // Remove from in-flight after done (success/failure)
      }

      // Save to WebM cache so subsequent requests are served from cache
      webmCacheSet(m3u8Url, webm);

      res.writeHead(200, {
        "Content-Type"  : "video/webm",
        "Content-Length": webm.length,
        "Cache-Control" : "no-store",
        "X-Cache"       : "MISS",
      });
      res.end(webm);
    } catch(e) {
      console.error("[proxy] transcode error:", e.message);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${e.message}`);
    }
    return;
  }

  // ── GET /cache/clear ──────────────────────────────────
  if (parsed.pathname === "/cache/clear") {
    const m3u8Count = cache.size;
    const webmCount = webmCache.size;
    cache.clear();
    webmCache.clear();
    console.log(`[proxy] cache cleared — m3u8: ${m3u8Count}, webm: ${webmCount} entries`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`Cache cleared (m3u8: ${m3u8Count}, webm: ${webmCount} entries removed)`);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ── Startup ────────────────────────────────────────────────
(async () => {
  await pickResolution();

  // Detect available VP9/VP8 encoder
  console.log("\n🔍 Detecting available WebM encoders...");
  availableEncoder = await detectEncoder();

  // Detect GPU decoder once before server starts
  console.log("\n🔍 Detecting hardware GPU decoder (all GPUs)...");
  gpuDecoder = await detectGpuDecoder();
  if (gpuDecoder) {
    console.log(`✅ GPU Decoder: ${gpuDecoder.label}`);
    console.log(`   Decode H.264 → GPU | Encode ${availableEncoder?.toUpperCase() || "VP8"} → CPU`);
    console.log(`   (Dedicated GPU used for decode, CPU encodes WebM — cannot be GPU-offloaded)`);
  } else {
    console.log(`ℹ️  No GPU decoder → all via CPU`);
  }

  server.listen(PORT, "127.0.0.1", () => {
    const resLabel   = selectedResolution?.label || "480p default";
    const decodeMode = gpuDecoder ? `GPU (${gpuDecoder.label})` : "CPU only";
    console.log(`\n✅ animart-proxy v6 running at http://localhost:${PORT}`);
    console.log(`   Resolusi      : ${resLabel}`);
    console.log(`   Encoder       : ${availableEncoder === "vp9" ? "VP9 (libvpx-vp9) — best quality" : "VP8 (libvpx) — fallback"}`);
    console.log(`   Bitrate       : Full quality (CRF mode — uncapped)`);
    console.log(`   Decode mode   : ${decodeMode}`);
    console.log(`   Health check  : http://localhost:${PORT}/ping`);
    console.log(`   Resolve art   : http://localhost:${PORT}/artwork?artist=Drake&title=Nokia`);
    console.log(`   Transcode     : http://localhost:${PORT}/transcode?url=<m3u8_url>`);
    console.log(`\n📡 3 APIs searched in PARALLEL (fastest wins, others ignored):`);
    console.log(`   API-1: artwork.m8tec.top`);
    console.log(`   API-2: iTunes Search + Apple Music AMP API`);
    console.log(`   API-3: iTunes Search + Apple Music web scraping`);
    console.log(`\n🗃  WebM Cache: max ${WEBM_CACHE_MAX} songs, TTL 2 hours`);
    console.log(`   Download + transcode only once per song, subsequent requests served from cache`);
    console.log(`\n💡 Tip: node animart-proxy.js 720  → directly select 720p`);
    console.log(`⚠  Make sure ffmpeg is installed: winget install ffmpeg\n`);
  });

  server.on("error", e => {
    if (e.code === "EADDRINUSE") {
      console.error(`❌ Port ${PORT} is already in use. Close other processes or change PORT.`);
    } else {
      console.error("Server error:", e.message);
    }
    process.exit(1);
  });
})();
