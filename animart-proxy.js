// ============================================================
//  animart-proxy.js  —  Local Transcode Proxy Server v5
//  GPU Hardware Encoding (auto-detect NVIDIA → AMD → Intel → CPU)
//
//  NVIDIA : H.264 → VP8/WebM via  hevc_nvenc  (tidak support WebM)
//           Workaround: decode H.264 CPU, encode output VP8 via GPU
//           Sebenarnya: NVENC hanya support H.264/HEVC/AV1, bukan VP8/VP9
//           Solusi terbaik: H.264(GPU decode) → scale(GPU) → VP8(CPU encode)
//           ATAU: pakai output H.264 dari NVENC → bungkus di mp4 blob
//           CEF Spotify tidak support H.264 via MSE, jadi output HARUS WebM VP8/VP9
//
//  Strategi GPU yang benar:
//   - Decode H.264 input pakai GPU (cuvid/d3d11va/vaapi) → hemat CPU saat decode
//   - Scale pakai GPU filter (scale_cuda / scale_vaapi)
//   - Encode output VP8 tetap CPU (libvpx) karena GPU tidak ada encoder VP8/VP9 WebM
//     KECUALI: av1_nvenc (RTX 40xx) → tapi CEF Spotify belum tentu support AV1 WebM
//
//  Jadi optimasi GPU yang bisa dilakukan:
//   NVIDIA: -hwaccel cuda -hwaccel_output_format cuda → scale_cuda → libvpx (CPU encode)
//   AMD   : -hwaccel d3d11va → scale → libvpx
//   Intel : -hwaccel d3d11va → scale → libvpx
//
//  Keuntungan: decode & scale di GPU → CPU lebih bebas untuk encode VP8
// ============================================================

const http   = require("http");
const https  = require("https");
const { spawn, execSync } = require("child_process");
const urlMod = require("url");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");

const PORT = 7799;

// ── Auto-detect ffmpeg ─────────────────────────────────────
function findFfmpeg() {
  try { execSync("ffmpeg -version", { stdio: "ignore" }); return "ffmpeg"; } catch(_) {}
  const wingetBase = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
  try {
    if (fs.existsSync(wingetBase)) {
      for (const pkg of fs.readdirSync(wingetBase)) {
        if (!pkg.toLowerCase().includes("ffmpeg")) continue;
        const found = findInDir(path.join(wingetBase, pkg), "ffmpeg.exe", 4);
        if (found) return found;
      }
    }
  } catch(_) {}
  for (const c of [
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
    path.join(os.homedir(), "scoop", "shims", "ffmpeg.exe"),
    path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
  ]) { if (fs.existsSync(c)) return c; }
  return null;
}

function findInDir(dir, filename, depth) {
  if (depth <= 0) return null;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === filename.toLowerCase()) return full;
      if (e.isDirectory()) { const f = findInDir(full, filename, depth-1); if (f) return f; }
    }
  } catch(_) {}
  return null;
}

const FFMPEG = findFfmpeg();
if (!FFMPEG) {
  console.error("❌ ffmpeg tidak ditemukan! Install: winget install ffmpeg");
  console.error("   Lalu buka terminal BARU dan jalankan ulang.");
  process.exit(1);
}
console.log(`✅ ffmpeg: ${FFMPEG}`);

// ── Deteksi GPU & pilih strategi hwaccel terbaik ───────────
//
//  Encoder VP8/VP9 WebM tidak tersedia di GPU manapun secara native.
//  Yang bisa di-GPU-kan adalah DECODE (input H.264) dan SCALE.
//  Output encode tetap libvpx di CPU, tapi jauh lebih ringan karena
//  CPU tidak perlu decode & scale lagi.
//
//  Urutan coba: CUDA (NVIDIA) → D3D11VA (AMD/Intel) → CPU fallback

function tryHwaccel(ffmpegBin, mode) {
  // Coba encode 1 frame dummy untuk test hwaccel
  return new Promise(resolve => {
    // Buat input dummy 1 frame
    const args = mode === "cuda" ? [
      "-loglevel", "error",
      "-hwaccel", "cuda",
      "-hwaccel_output_format", "cuda",
      "-f", "lavfi", "-i", "color=black:s=64x64:r=1:d=0.1",
      "-vf", "scale_cuda=64:64",
      "-c:v", "libvpx", "-frames:v", "1",
      "-f", "webm", "-"
    ] : mode === "d3d11va" ? [
      "-loglevel", "error",
      "-hwaccel", "d3d11va",
      "-f", "lavfi", "-i", "color=black:s=64x64:r=1:d=0.1",
      "-c:v", "libvpx", "-frames:v", "1",
      "-f", "webm", "-"
    ] : null;

    if (!args) return resolve(false);

    const ff = spawn(ffmpegBin, args);
    let ok = false;
    ff.stdout.on("data", () => { ok = true; });
    ff.on("close", code => resolve(ok && code === 0));
    ff.on("error", () => resolve(false));
    setTimeout(() => { try { ff.kill(); } catch(_) {} resolve(false); }, 5000);
  });
}

// Deteksi GPU saat startup
let GPU_MODE = "cpu"; // "cuda" | "d3d11va" | "cpu"

async function detectGpu() {
  console.log("[proxy] Mendeteksi GPU untuk hardware acceleration...");

  // Cek CUDA (NVIDIA)
  const hasCuda = await tryHwaccel(FFMPEG, "cuda");
  if (hasCuda) {
    GPU_MODE = "cuda";
    console.log("✅ GPU: NVIDIA CUDA terdeteksi — decode H.264 via GPU");
    return;
  }

  // Cek D3D11VA (AMD / Intel)
  const hasD3d = await tryHwaccel(FFMPEG, "d3d11va");
  if (hasD3d) {
    GPU_MODE = "d3d11va";
    console.log("✅ GPU: D3D11VA terdeteksi (AMD/Intel) — decode H.264 via GPU");
    return;
  }

  GPU_MODE = "cpu";
  console.log("⚠  GPU hwaccel tidak tersedia — fallback ke CPU (masih cepat)");
}

// ── Build ffmpeg args berdasarkan GPU_MODE ─────────────────
function buildFfmpegArgs(inputIsFile = false, inputPath = "pipe:0") {
  // Output selalu WebM VP8 karena CEF Spotify tidak support H.264 via MSE
  // VP8 encode lebih cepat dari VP9, kualitas cukup untuk animasi artwork
  const commonOutput = [
    "-c:v",      "libvpx",      // VP8 — paling kompatibel di CEF
    "-quality",  "realtime",
    "-cpu-used", "8",           // CPU VP8 encode di speed max (GPU sudah handle decode/scale)
    "-b:v",      "3000k",       // cukup untuk 720p
    "-vf",       "scale=-2:720",
    "-r",        "30",
    "-an",
    "-f",        "webm",
    "pipe:1"
  ];

  if (GPU_MODE === "cuda") {
    // NVIDIA: decode pakai CUDA, scale di GPU, encode VP8 di CPU
    return [
      "-loglevel",              "warning",
      "-hwaccel",               "cuda",
      "-hwaccel_output_format", "cuda",   // frame tetap di VRAM setelah decode
      "-i",                     inputPath,
      // scale_cuda: resize di GPU sebelum download ke RAM untuk encode
      "-vf", "scale_cuda=-2:720,hwdownload,format=nv12",
      "-c:v",      "libvpx",
      "-quality",  "realtime",
      "-cpu-used", "8",
      "-b:v",      "3000k",
      "-r",        "30",
      "-an",
      "-f",        "webm",
      "pipe:1"
    ];
  }

  if (GPU_MODE === "d3d11va") {
    // AMD/Intel: decode pakai D3D11VA, scale di CPU (D3D11VA hanya decode)
    return [
      "-loglevel", "warning",
      "-hwaccel",  "d3d11va",
      "-i",        inputPath,
      ...commonOutput
    ];
  }

  // CPU fallback
  return [
    "-loglevel", "warning",
    "-i",        inputPath,
    ...commonOutput
  ];
}

// ── Fetch helpers ──────────────────────────────────────────
function fetchBuf(targetUrl) {
  return new Promise((resolve, reject) => {
    const proto = targetUrl.startsWith("https") ? https : http;
    const req = proto.get(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AnimArt-Proxy/5)", "Accept": "*/*" }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(fetchBuf(res.headers.location));
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const c = [];
      res.on("data", d => c.push(d));
      res.on("end",  () => resolve(Buffer.concat(c)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}
async function fetchText(u) { return (await fetchBuf(u)).toString("utf8"); }

// ── Parse M3U8 ─────────────────────────────────────────────
async function resolveSegments(m3u8Url, maxSegs = 3, depth = 0) {
  if (depth > 3) throw new Error("M3U8 terlalu dalam");
  const base  = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
  const text  = await fetchText(m3u8Url);
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  if (text.includes("#EXT-X-STREAM-INF")) {
    const streams = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
      const bw = parseInt(lines[i].match(/BANDWIDTH=(\d+)/)?.[1] || "0");
      const h  = parseInt(lines[i].match(/RESOLUTION=\d+x(\d+)/)?.[1] || "9999");
      const u  = lines[i+1]?.startsWith("http") ? lines[i+1] : base + lines[i+1];
      if (u) streams.push({ bw, h, u });
    }
    streams.sort((a, b) => b.bw - a.bw);
    const pick = streams.find(s => s.h <= 720) || streams.find(s => s.h <= 1080) || streams[0];
    console.log(`[proxy] stream: ${pick.h}p (${Math.round(pick.bw/1000)}kbps)`);
    return resolveSegments(pick.u, maxSegs, depth + 1);
  }

  const segs = lines.filter(l => !l.startsWith("#") && l.length > 4)
                    .map(l => l.startsWith("http") ? l : base + l);
  const take = segs.slice(0, maxSegs);
  console.log(`[proxy] ${segs.length} segment tersedia, ambil ${take.length}`);
  return take;
}

// ── Transcode: combined TS buffer → WebM ──────────────────
function transcodeBuffer(combined) {
  return new Promise((resolve, reject) => {
    console.log(`[proxy] input: ${(combined.length/1024).toFixed(0)} KB → transcode [${GPU_MODE.toUpperCase()}]...`);

    const args = buildFfmpegArgs();
    const ff   = spawn(FFMPEG, args);

    const chunks = [];
    ff.stdout.on("data", c => chunks.push(c));
    ff.stderr.on("data", d => process.stderr.write(d.toString()));
    ff.on("close", code => {
      if (code === 0 && chunks.length > 0) {
        const out = Buffer.concat(chunks);
        console.log(`[proxy] ✓ WebM: ${(out.length/1024).toFixed(0)} KB [${GPU_MODE.toUpperCase()}]`);
        resolve(out);
      } else {
        // Jika GPU gagal saat encode (bukan saat test), fallback ke CPU
        if (GPU_MODE !== "cpu") {
          console.log(`[proxy] GPU encode gagal, fallback CPU...`);
          const prevMode = GPU_MODE;
          GPU_MODE = "cpu";
          transcodeBuffer(combined).then(resolve).catch(reject).finally(() => {
            GPU_MODE = prevMode; // restore untuk request berikutnya (mungkin GPU ok lagi)
          });
        } else {
          reject(new Error(`ffmpeg exit ${code}`));
        }
      }
    });
    ff.on("error", reject);
    ff.stdin.write(combined);
    ff.stdin.end();
  });
}

// ── Cache: 1 lagu aktif saja ──────────────────────────────
let activeCache = null;
function getCached(u)   { return activeCache?.url === u ? activeCache.webm : null; }
function setCache(u, w) { activeCache = { url: u, webm: w }; }
function clearCache(u) {
  if (!u || activeCache?.url === u) {
    if (activeCache) console.log(`[proxy] cache dihapus (${(activeCache.webm.length/1024).toFixed(0)} KB dibebaskan)`);
    activeCache = null;
  }
}

// ── HTTP Server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = urlMod.parse(req.url, true);

  if (parsed.pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`animart-proxy v5 OK | ffmpeg: ${path.basename(FFMPEG)} | GPU: ${GPU_MODE.toUpperCase()}`);
    return;
  }

  if (parsed.pathname === "/cache/clear") {
    clearCache(parsed.query.url || null);
    res.writeHead(200); res.end("cleared");
    return;
  }

  if (parsed.pathname === "/transcode") {
    const m3u8Url = parsed.query.url;
    if (!m3u8Url) { res.writeHead(400); res.end("Missing ?url="); return; }

    const cached = getCached(m3u8Url);
    if (cached) {
      console.log(`[proxy] cache hit (${(cached.length/1024).toFixed(0)} KB)`);
      res.writeHead(200, { "Content-Type": "video/webm", "Content-Length": cached.length });
      res.end(cached);
      return;
    }

    console.log(`\n[proxy] ▶ ${m3u8Url.slice(0, 70)}...`);
    const t0 = Date.now();
    try {
      const segs = await resolveSegments(m3u8Url, 2);
      console.log(`[proxy] download ${segs.length} segment paralel...`);
      const tsBufs = await Promise.all(segs.map(async (seg, i) => {
        const buf = await fetchBuf(seg);
        console.log(`[proxy]   seg${i+1}: ${(buf.length/1024).toFixed(0)} KB`);
        return buf;
      }));
      const combined = Buffer.concat(tsBufs);
      console.log(`[proxy] total TS: ${(combined.length/1024).toFixed(0)} KB`);

      const webm = await transcodeBuffer(combined);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[proxy] ✅ selesai ${elapsed}s`);

      setCache(m3u8Url, webm);
      res.writeHead(200, { "Content-Type": "video/webm", "Content-Length": webm.length });
      res.end(webm);
    } catch(e) {
      console.error("[proxy] ERROR:", e.message);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${e.message}`);
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ── Startup ────────────────────────────────────────────────
(async () => {
  await detectGpu(); // deteksi GPU sebelum server mulai listen

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`\n✅ animart-proxy v5 berjalan di http://localhost:${PORT}`);
    console.log(`   Mode encode : ${GPU_MODE.toUpperCase()}`);
    console.log(`   /ping       — health check (tampilkan GPU mode)`);
    console.log(`   /transcode  — transcode HLS → WebM`);
    console.log(`   /cache/clear— hapus cache lagu aktif\n`);
  });

  server.on("error", e => {
    if (e.code === "EADDRINUSE") console.error(`❌ Port ${PORT} sudah dipakai.`);
    else console.error("Server error:", e.message);
    process.exit(1);
  });
})();
