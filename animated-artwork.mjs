// ============================================================
//  animated-artwork.mjs  —  Spicetify Extension v9
//  Fix: simbol di judul/album di-sanitize sebelum API call
//  Fix: cache lagu sebelumnya dihapus saat pindah lagu
//  Fix: transcode lebih cepat (3 segment, bukan 8)
// ============================================================

(async function AnimatedArtworkV9() {

  while (!Spicetify?.Player?.addEventListener || !Spicetify?.Player?.data) {
    await new Promise(r => setTimeout(r, 200));
  }

  const API        = "https://artwork.m8tec.top/api/v1/artwork/search";
  const PROXY_BASE = "http://localhost:7799";
  const TAG        = "[AnimArt]";
  const L          = (...a) => console.log(`%c${TAG}`, "color:#1DB954;font-weight:bold", ...a);
  const E          = (...a) => console.error(`%c${TAG}`, "color:#f55;font-weight:bold", ...a);

  // ── Sanitize teks untuk API query ─────────────────────────
  // Hapus/ganti simbol yang bisa rusak URL atau bingungkan API
  function sanitize(str) {
    if (!str) return "";
    return str
      // Ganti simbol dolar dan khusus jadi spasi atau dibuang
      .replace(/\$/g, "S")          // $ome → Some
      .replace(/[&+#%@=]/g, " ")    // simbol umum → spasi
      .replace(/[^\w\s\-'.,()]/g, "") // buang karakter aneh sisanya
      .replace(/\s+/g, " ")          // normalisasi spasi ganda
      .trim();
  }

  // ── Cek proxy aktif ────────────────────────────────────────
  async function isProxyAlive() {
    try {
      const r = await fetch(`${PROXY_BASE}/ping`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  }

  // ── Kirim sinyal clear cache ke proxy ─────────────────────
  async function clearProxyCache(m3u8Url) {
    if (!m3u8Url) return;
    try {
      await fetch(`${PROXY_BASE}/cache/clear?url=${encodeURIComponent(m3u8Url)}`, {
        signal: AbortSignal.timeout(1000)
      });
    } catch(_) {}
  }

  // ── ProxyPlayer ────────────────────────────────────────────
  class ProxyPlayer {
    constructor(id) {
      this.id      = id;
      this.video   = null;
      this.canvas  = null;
      this.ctx     = null;
      this.raf     = null;
      this.running = false;
      this.blobUrl = null;
    }

    _mount(container) {
      document.getElementById(`${this.id}-video`)?.remove();
      document.getElementById(`${this.id}-canvas`)?.remove();

      const video         = document.createElement("video");
      video.id            = `${this.id}-video`;
      video.muted         = true;
      video.loop          = true;
      video.playsInline   = true;
      video.autoplay      = true;
      video.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;";
      document.body.appendChild(video);

      const canvas         = document.createElement("canvas");
      canvas.id            = `${this.id}-canvas`;
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;z-index:10;pointer-events:none;opacity:0;transition:opacity 0.5s ease";
      container.style.position = "relative";
      container.style.overflow = "hidden";
      container.appendChild(canvas);

      this.video  = video;
      this.canvas = canvas;
      this.ctx    = canvas.getContext("2d");
    }

    _startMirror() {
      this.running = true;
      let lastTime  = 0;
      // Throttle ke 24fps — artwork tidak perlu 60fps, hemat CPU & hilangkan lag
      const TARGET_MS = 1000 / 24;

      const draw = (now) => {
        if (!this.running) return;
        this.raf = requestAnimationFrame(draw);

        // Skip frame jika belum waktunya (throttle 24fps)
        if (now - lastTime < TARGET_MS) return;
        lastTime = now;

        const v = this.video;
        if (!v || v.readyState < 2 || v.paused || v.ended || v.videoWidth === 0) return;

        const { videoWidth: w, videoHeight: h } = v;
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w; this.canvas.height = h;
        }
        this.ctx.drawImage(v, 0, 0, w, h);
        if (this.canvas.style.opacity !== "1") {
          this.canvas.style.opacity = "1";
          L(`${this.id}: ✓ animasi tampil (${w}×${h})`);
        }
      };
      this.raf = requestAnimationFrame(draw);
    }

    async play(container, m3u8Url) {
      this.stop();
      this._mount(container);
      L(`${this.id}: meminta transcode...`);
      try {
        const proxyUrl = `${PROXY_BASE}/transcode?url=${encodeURIComponent(m3u8Url)}`;
        const resp     = await fetch(proxyUrl);
        if (!resp.ok) {
          E(`${this.id}: proxy error ${resp.status}:`, await resp.text().catch(() => ""));
          return false;
        }
        const webmBuf = await resp.arrayBuffer();
        L(`${this.id}: WebM diterima (${(webmBuf.byteLength/1024).toFixed(0)} KB)`);

        if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
        const blob     = new Blob([webmBuf], { type: "video/webm" });
        this.blobUrl   = URL.createObjectURL(blob);
        this.video.src = this.blobUrl;

        await new Promise((resolve, reject) => {
          this.video.oncanplay = resolve;
          this.video.onerror   = () => reject(new Error(`video error: ${this.video.error?.message || "?"}`));
          setTimeout(() => reject(new Error("timeout canplay")), 10000);
        });

        this.video.play().catch(e => E(`${this.id}: play error:`, e.message));
        this._startMirror();
        return true;
      } catch(e) {
        E(`${this.id}: play gagal:`, e.message);
        return false;
      }
    }

    stop() {
      this.running = false;
      if (this.raf)    { cancelAnimationFrame(this.raf); this.raf = null; }
      if (this.video)  { this.video.pause(); this.video.src = ""; this.video.remove(); this.video = null; }
      if (this.blobUrl){ URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
      document.getElementById(`${this.id}-canvas`)?.remove();
      this.canvas = null; this.ctx = null;
    }
  }

  // ── Globals ────────────────────────────────────────────────
  let currentUri = null;
  let lastM3u8   = null;
  let proxyOk    = false;
  const playerNPV = new ProxyPlayer("animart-npv");
  const playerSL  = new ProxyPlayer("animart-sl");

  // ── Fetch artwork API ──────────────────────────────────────
  async function fetchM3u8(artist, album, title) {
    // Coba dua kali: dengan teks asli, lalu dengan teks disanitize
    const attempts = [
      { artist, album, title },
      { artist: sanitize(artist), album: sanitize(album), title: sanitize(title) },
    ];

    for (const q of attempts) {
      // Skip kalau sama persis dengan attempt sebelumnya
      if (q.artist === attempts[0].artist && q !== attempts[0]) continue;

      const params = new URLSearchParams({
        artist: q.artist || "",
        album : q.album  || "",
        title : q.title  || "",
      });
      L(`Fetch API: artist="${q.artist}" album="${q.album}" title="${q.title}"`);
      try {
        const res  = await fetch(`${API}?${params}`, { headers: { Accept: "application/json" } });
        if (!res.ok) { E(`API ${res.status}`); continue; }
        const json = await res.json();
        const item = Array.isArray(json) ? json[0] : json;
        const m3u8 = item?.m3u8Url || item?.hlsUrl || item?.videoUrl ||
                     item?.url     || item?.hls_url || item?.stream_url ||
                     item?.variants?.[0]?.url || item?.results?.[0]?.m3u8Url || null;
        if (m3u8) { L(`✓ Animasi ditemukan`); return m3u8; }
        L(`Attempt "${q.title}": tidak ada animasi`);
      } catch(e) { E("fetchM3u8:", e.message); }
    }

    // Fallback: coba hanya dengan title saja (tanpa album — album bermasalah bisa ganggu search)
    if (title) {
      const params = new URLSearchParams({ artist: sanitize(artist), title: sanitize(title) });
      L(`Fallback: title-only "${sanitize(title)}"`);
      try {
        const res  = await fetch(`${API}?${params}`, { headers: { Accept: "application/json" } });
        if (res.ok) {
          const json = await res.json();
          const item = Array.isArray(json) ? json[0] : json;
          const m3u8 = item?.m3u8Url || item?.hlsUrl || item?.videoUrl ||
                       item?.url     || item?.hls_url || item?.stream_url ||
                       item?.variants?.[0]?.url || item?.results?.[0]?.m3u8Url || null;
          if (m3u8) { L(`✓ Animasi ditemukan (title-only fallback)`); return m3u8; }
        }
      } catch(_) {}
    }

    return null;
  }

  // ── DOM finders ────────────────────────────────────────────
  const findNpv = () =>
    document.querySelector(".MediaImageContainer") ||
    document.querySelector("[data-testid='cover-art-image']")?.closest("[data-testid='cover-art']") ||
    document.querySelector("[data-testid='now-playing-widget'] [data-testid='cover-art']") ||
    document.querySelector(".main-coverSlotExpanded-container") || null;

  const findSL = () => {
    const p = document.querySelector("#SpicyLyricsPage") ||
              document.querySelector(".spicylyrics-page") ||
              document.querySelector("[class*='SpicyLyrics']");
    if (!p) return null;
    return p.querySelector(".MediaImageContainer") ||
           p.querySelector("[data-testid='cover-art']") || p;
  };

  async function tryInject(player, finder, label, m3u8, tries = 20) {
    for (let i = 0; i < tries; i++) {
      const el = finder();
      if (el) {
        const ok = await player.play(el, m3u8);
        if (ok) { L(`✓ ${label}`); return true; }
        return false;
      }
      await new Promise(r => setTimeout(r, 400));
    }
    L(`⚠ ${label}: container tidak ditemukan`);
    return false;
  }

  // ── Song change ────────────────────────────────────────────
  async function onSongChange() {
    const track = Spicetify.Player.data?.item;
    if (!track) return;
    const uri = track.uri;
    if (uri === currentUri) return;
    currentUri = uri;

    const artist = track.metadata?.artist_name || "";
    const album  = track.metadata?.album_title  || "";
    const title  = track.metadata?.title        || "";
    L(`▶ "${title}" — ${artist} [album: ${album}]`);

    // Stop player lama & hapus cache lagu sebelumnya di proxy
    playerNPV.stop();
    playerSL.stop();
    if (lastM3u8) {
      clearProxyCache(lastM3u8);
      L("Cache lagu sebelumnya dihapus");
    }
    lastM3u8 = null;

    if (!artist && !title) return;

    proxyOk = await isProxyAlive();
    if (!proxyOk) {
      E("⚠ Proxy tidak aktif! Jalankan: node animart-proxy.js");
      return;
    }

    const m3u8 = await fetchM3u8(artist, album, title);
    if (!m3u8) { L("Tidak ada animasi untuk lagu ini"); return; }
    lastM3u8 = m3u8;

    tryInject(playerNPV, findNpv, "Now Bar",      m3u8);
    tryInject(playerSL,  findSL,  "Spicy Lyrics", m3u8);
  }

  // ── MutationObserver ──────────────────────────────────────
  new MutationObserver(() => {
    if (!lastM3u8 || !proxyOk) return;
    if (!document.getElementById("animart-npv-canvas")) tryInject(playerNPV, findNpv, "NPV (re)", lastM3u8, 5);
    if (!document.getElementById("animart-sl-canvas"))  tryInject(playerSL,  findSL,  "SL (re)",  lastM3u8, 5);
  }).observe(document.body, { childList: true, subtree: true });

  // ── Init ──────────────────────────────────────────────────
  L("Extension v10 — simbol fix + cache clear + faster transcode");
  proxyOk = await isProxyAlive();
  if (proxyOk) L("✓ Proxy aktif di localhost:7799");
  else {
    E("⚠ Proxy TIDAK aktif!");
    E("  Jalankan: node animart-proxy.js");
  }

  Spicetify.Player.addEventListener("songchange", onSongChange);
  await onSongChange();
  L("Extension siap ✓ (24fps throttle)");

})();
