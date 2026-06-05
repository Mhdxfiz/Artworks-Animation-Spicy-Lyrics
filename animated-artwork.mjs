// ============================================================
//  animated-artwork.mjs  —  Spicetify Extension v14
//  3 API paralel (via proxy v2)
//  - requestVideoFrameCallback: frame-perfect sync (no lag, no stutter)
//  - Fallback rAF 60fps jika browser tidak support rVFC
//  - Canvas context: alpha=false untuk render lebih cepat
//  - MutationObserver dengan debounce + guard agar tidak spam
//  - Re-inject hanya jika canvas benar-benar hilang dari DOM
//    DAN tidak sedang dalam proses inject
//  - Proxy log cache hit tidak spam (dibatasi di sisi proxy)
// ============================================================

(async function AnimatedArtworkV14() {

  while (!Spicetify?.Player?.addEventListener || !Spicetify?.Player?.data) {
    await new Promise(r => setTimeout(r, 200));
  }

  const PROXY_BASE = "http://localhost:7799";
  const TAG        = "[AnimArt]";
  const L          = (...a) => console.log(`%c${TAG}`, "color:#1DB954;font-weight:bold", ...a);
  const E          = (...a) => console.error(`%c${TAG}`, "color:#f55;font-weight:bold", ...a);

  // ── Cek proxy aktif ────────────────────────────────────────
  async function isProxyAlive() {
    try {
      const r = await fetch(`${PROXY_BASE}/ping`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  }

  // ── ProxyPlayer ────────────────────────────────────────────
  class ProxyPlayer {
    constructor(id) {
      this.id         = id;
      this.video      = null;
      this.canvas     = null;
      this.ctx        = null;
      this.raf        = null;
      this.running    = false;
      this.blobUrl    = null;
      this.isPlaying  = false; // Guard: sedang aktif playing
      this.isInjecting = false; // Guard: sedang dalam proses inject
    }

    destroy() {
      this.running     = false;
      this.isPlaying   = false;
      this.isInjecting = false;

      // Hentikan draw loop (rAF atau requestVideoFrameCallback)
      if (this._stopMirror) { this._stopMirror(); this._stopMirror = null; }
      if (this.raf)         { cancelAnimationFrame(this.raf); this.raf = null; }
      if (this._rvfcId && this.video) {
        try { this.video.cancelVideoFrameCallback(this._rvfcId); } catch(_) {}
        this._rvfcId = null;
      }

      if (this.video)  {
        this.video.pause();
        this.video.src = "";
        this.video.load();
        this.video.remove();
        this.video = null;
      }
      if (this.blobUrl){ URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }

      document.getElementById(`${this.id}-canvas`)?.remove();
      this.canvas = null;
      this.ctx    = null;
    }

    // Cek apakah canvas masih ada di DOM dan video masih jalan
    isActive() {
      return this.isPlaying &&
             !!document.getElementById(`${this.id}-canvas`) &&
             !!this.video && !this.video.paused;
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
      // Tambahan: hint browser agar buffer lebih banyak untuk playback mulus
      video.preload       = "auto";
      video.setAttribute("playbackRate", "1");
      video.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;";
      document.body.appendChild(video);

      const canvas         = document.createElement("canvas");
      canvas.id            = `${this.id}-canvas`;
      canvas.dataset.animart = "1";
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;z-index:10;pointer-events:none;opacity:0;transition:opacity 0.3s ease";
      container.style.position = "relative";
      container.style.overflow = "hidden";
      container.appendChild(canvas);

      this.video  = video;
      this.canvas = canvas;
      // willReadFrequently=false: kita hanya menulis (drawImage), tidak membaca pixel
      // alpha=false: sedikit lebih cepat karena tidak perlu kalkulasi alpha channel
      this.ctx    = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
    }

    _startMirror() {
      this.running = true;

      const v = this.video;

      // ── Mode 1: requestVideoFrameCallback (Chrome 83+, Edge 83+) ──────────
      // Dipanggil TEPAT saat video punya frame baru → tidak ada frame yang
      // dilewati, tidak ada frame duplikat. Paling smooth & paling efisien.
      if (typeof v.requestVideoFrameCallback === "function") {
        L(`${this.id}: menggunakan requestVideoFrameCallback (frame-perfect sync)`);

        const onFrame = (now, meta) => {
          if (!this.running) return;

          const { videoWidth: w, videoHeight: h } = v;
          if (w === 0 || h === 0) { v.requestVideoFrameCallback(onFrame); return; }

          if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w; this.canvas.height = h;
          }

          try {
            this.ctx.drawImage(v, 0, 0, w, h);
          } catch(_) { return; }

          if (this.canvas.style.opacity !== "1") {
            this.canvas.style.opacity = "1";
            L(`${this.id}: ✓ animasi tampil (${w}×${h}) @ ${meta?.presentedFrames || "?"} frames`);
          }

          // Daftarkan callback untuk frame berikutnya
          this._rvfcId = v.requestVideoFrameCallback(onFrame);
        };

        this._rvfcId = v.requestVideoFrameCallback(onFrame);

        // Simpan cleanup untuk destroy()
        this._stopMirror = () => {
          if (this._rvfcId) { v.cancelVideoFrameCallback(this._rvfcId); this._rvfcId = null; }
        };
        return;
      }

      // ── Mode 2: requestAnimationFrame @ 60fps (fallback) ──────────────────
      // Guard document.visibilityState: tab hidden → rAF di-throttle browser ke ~1fps,
      // lalu burst saat kembali visible → stutter. Skip draw saat hidden.
      L(`${this.id}: menggunakan rAF 60fps (requestVideoFrameCallback tidak tersedia)`);

      const draw = () => {
        if (!this.running) return;
        this.raf = requestAnimationFrame(draw);

        // Skip draw saat tab hidden — hindari burst saat kembali focused
        if (document.visibilityState === "hidden") return;

        if (!v || v.readyState < 2 || v.paused || v.ended || v.videoWidth === 0) return;

        const { videoWidth: w, videoHeight: h } = v;
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w; this.canvas.height = h;
        }

        try {
          this.ctx.drawImage(v, 0, 0, w, h);
        } catch(_) { return; }

        if (this.canvas.style.opacity !== "1") {
          this.canvas.style.opacity = "1";
          L(`${this.id}: ✓ animasi tampil (${w}×${h})`);
        }
      };
      this.raf = requestAnimationFrame(draw);

      this._stopMirror = () => {
        if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
      };
    }

    async play(container, m3u8Url) {
      this.destroy();
      this._mount(container);
      this.isInjecting = true;
      L(`${this.id}: meminta transcode...`);
      try {
        const proxyUrl = `${PROXY_BASE}/transcode?url=${encodeURIComponent(m3u8Url)}`;
        const resp     = await fetch(proxyUrl);
        if (!resp.ok) {
          E(`${this.id}: proxy error ${resp.status}:`, await resp.text().catch(() => ""));
          this.isInjecting = false;
          return false;
        }

        // Streaming read — kumpulkan chunk sambil tetap bisa mulai decode lebih awal
        const reader = resp.body.getReader();
        const chunks = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalBytes += value.byteLength;
        }
        const webmBuf = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) { webmBuf.set(chunk, offset); offset += chunk.byteLength; }
        L(`${this.id}: WebM diterima (${(totalBytes / 1024).toFixed(0)} KB)`);

        const blob     = new Blob([webmBuf], { type: "video/webm" });
        this.blobUrl   = URL.createObjectURL(blob);
        this.video.src = this.blobUrl;

        await new Promise((resolve, reject) => {
          this.video.oncanplay = resolve;
          this.video.onerror   = () => reject(new Error(`video error: ${this.video.error?.message || "?"}`));
          setTimeout(() => reject(new Error("timeout canplay")), 8000);
        });

        this.video.play().catch(e => E(`${this.id}: play error:`, e.message));
        this._startMirror();
        this.isPlaying   = true;
        this.isInjecting = false;
        return true;
      } catch(e) {
        E(`${this.id}: play gagal:`, e.message);
        this.destroy();
        return false;
      }
    }
  }

  // ── Globals ────────────────────────────────────────────────
  let currentUri = null;
  let lastM3u8   = null;
  let proxyOk    = false;
  const playerNPV = new ProxyPlayer("animart-npv");
  const playerSL  = new ProxyPlayer("animart-sl");

  // ── Fetch m3u8 via proxy ───────────────────────────────────
  async function fetchM3u8(artist, album, title) {
    const params = new URLSearchParams({ artist: artist||"", album: album||"", title: title||"" });
    L(`Fetch: "${title}" — ${artist}`);
    try {
      const resp = await fetch(`${PROXY_BASE}/artwork?${params}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) { E(`Proxy /artwork error: ${resp.status}`); return null; }
      const json = await resp.json();
      if (json.m3u8) { L(`✓ m3u8 ditemukan`); return json.m3u8; }
      L("Tidak ada animated artwork untuk lagu ini");
      return null;
    } catch(e) { E("fetchM3u8 error:", e.message); return null; }
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
    // Guard: jangan inject kalau sedang inject atau sudah aktif
    if (player.isInjecting) return false;
    if (player.isActive())  return true; // Sudah jalan, tidak perlu inject ulang

    player.isInjecting = true;
    try {
      for (let i = 0; i < tries; i++) {
        const el = finder();
        if (el) {
          const ok = await player.play(el, m3u8); // play() akan set isInjecting=false sendiri
          if (ok) L(`✓ ${label}`);
          return ok;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      L(`⚠ ${label}: container tidak ditemukan`);
    } finally {
      player.isInjecting = false;
    }
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
    L(`▶ "${title}" — ${artist}`);

    playerNPV.destroy();
    playerSL.destroy();
    lastM3u8 = null;

    if (!artist && !title) return;

    proxyOk = await isProxyAlive();
    if (!proxyOk) { E("⚠ Proxy tidak aktif! Jalankan: node animart-proxy.js"); return; }

    const m3u8 = await fetchM3u8(artist, album, title);
    if (!m3u8) { L("Tidak ada animasi untuk lagu ini"); return; }
    lastM3u8 = m3u8;

    tryInject(playerNPV, findNpv, "Now Bar",      m3u8);
    tryInject(playerSL,  findSL,  "Spicy Lyrics", m3u8);
  }

  // ── MutationObserver — re-inject HANYA jika canvas hilang ─
  // Debounce 800ms: tunggu DOM selesai berubah sebelum cek.
  // Ini mencegah spam saat canvas sendiri trigger mutation
  // (karena canvas yang kita tulis via drawImage juga bisa
  //  memicu childList/subtree mutation di beberapa browser).
  let observerTimer = null;

  // Observer dikonfigurasi TIDAK mengamati canvas kita sendiri
  // dengan filter: hanya peduli node yang bukan milik animart
  const observer = new MutationObserver((mutations) => {
    if (!lastM3u8 || !proxyOk) return;

    // Filter: abaikan mutation yang berasal dari canvas/video animart itu sendiri
    const relevant = mutations.some(m => {
      for (const node of m.addedNodes) {
        if (node.dataset?.animart) return false; // node milik kita, abaikan
      }
      for (const node of m.removedNodes) {
        // Jika canvas animart kita yang di-remove, ini relevan
        if (node.id === "animart-npv-canvas" || node.id === "animart-sl-canvas") return true;
      }
      // Cek target: jika mutation terjadi di dalam canvas animart kita, abaikan
      const target = m.target;
      if (target?.dataset?.animart || target?.id?.startsWith("animart-")) return false;
      return true;
    });

    if (!relevant) return;

    // Debounce: tunggu 800ms setelah DOM stabil
    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      // Re-inject hanya jika canvas BENAR-BENAR tidak ada di DOM
      // DAN player tidak sedang aktif/inject
      if (!playerNPV.isActive() && !playerNPV.isInjecting) {
        tryInject(playerNPV, findNpv, "NPV (re)", lastM3u8, 5);
      }
      if (!playerSL.isActive() && !playerSL.isInjecting) {
        tryInject(playerSL, findSL, "SL (re)", lastM3u8, 5);
      }
    }, 800);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ── Init ──────────────────────────────────────────────────
  L("Extension v14 — rVFC frame-perfect + 60fps fallback (visibility guard) + VP9 full quality + streaming fetch");
  proxyOk = await isProxyAlive();
  if (proxyOk) L("✓ Proxy aktif di localhost:7799");
  else { E("⚠ Proxy TIDAK aktif!"); E("  Jalankan: node animart-proxy.js"); }

  Spicetify.Player.addEventListener("songchange", onSongChange);
  await onSongChange();
  L("Extension siap ✓");

})();
