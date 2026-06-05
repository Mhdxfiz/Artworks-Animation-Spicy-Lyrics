// ============================================================
//  animated-artwork.mjs  —  Spicetify Extension v2
//  Requires: animart-proxy v2 running at localhost:7799
// ============================================================

(async function AnimatedArtworkV2() {

  while (!Spicetify?.Player?.addEventListener || !Spicetify?.Player?.data) {
    await new Promise(r => setTimeout(r, 200));
  }

  const PROXY_BASE = "http://localhost:7799";
  const TAG        = "[AnimArt]";
  const L          = (...a) => console.log(`%c${TAG}`, "color:#1DB954;font-weight:bold", ...a);
  const E          = (...a) => console.error(`%c${TAG}`, "color:#f55;font-weight:bold", ...a);

  async function isProxyAlive() {
    try {
      const r = await fetch(`${PROXY_BASE}/ping`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  }

  class ProxyPlayer {
    constructor(id) {
      this.id          = id;
      this.video       = null;
      this.canvas      = null;
      this.ctx         = null;
      this.raf         = null;
      this._rvfcId     = null;
      this._stopMirror = null;
      this.running     = false;
      this.blobUrl     = null;
      this.isPlaying   = false;
      this.isInjecting = false;
    }

    destroy() {
      this.running     = false;
      this.isPlaying   = false;
      this.isInjecting = false;

      if (this._stopMirror) { this._stopMirror(); this._stopMirror = null; }
      if (this.raf)         { cancelAnimationFrame(this.raf); this.raf = null; }
      if (this._rvfcId && this.video) {
        try { this.video.cancelVideoFrameCallback(this._rvfcId); } catch (_) {}
        this._rvfcId = null;
      }
      if (this.video) {
        this.video.pause();
        this.video.src = "";
        this.video.load();
        this.video.remove();
        this.video = null;
      }
      if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
      document.getElementById(`${this.id}-canvas`)?.remove();
      this.canvas = null;
      this.ctx    = null;
    }

    isActive() {
      if (!this.isPlaying || !this.video || this.video.paused) return false;
      const canvas = document.getElementById(`${this.id}-canvas`);
      return !!canvas && document.body.contains(canvas);
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
      video.preload       = "auto";
      video.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;";
      document.body.appendChild(video);

      const canvas           = document.createElement("canvas");
      canvas.id              = `${this.id}-canvas`;
      canvas.dataset.animart = "1";
      canvas.style.cssText   = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;z-index:10;pointer-events:none;opacity:0;transition:opacity 0.3s ease";
      container.style.position = "relative";
      container.style.overflow = "hidden";
      container.appendChild(canvas);

      this.video = video;
      this.canvas = canvas;
      this.ctx   = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
    }

    _startMirror() {
      this.running = true;
      const v = this.video;

      if (typeof v.requestVideoFrameCallback === "function") {
        const onFrame = (now, meta) => {
          if (!this.running) return;
          const { videoWidth: w, videoHeight: h } = v;
          if (w === 0 || h === 0) { this._rvfcId = v.requestVideoFrameCallback(onFrame); return; }
          if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w; this.canvas.height = h;
          }
          try { this.ctx.drawImage(v, 0, 0, w, h); } catch (_) { return; }
          if (this.canvas.style.opacity !== "1") {
            this.canvas.style.opacity = "1";
            L(`${this.id}: ✓ visible (${w}×${h})`);
          }
          this._rvfcId = v.requestVideoFrameCallback(onFrame);
        };
        this._rvfcId     = v.requestVideoFrameCallback(onFrame);
        this._stopMirror = () => {
          if (this._rvfcId) { v.cancelVideoFrameCallback(this._rvfcId); this._rvfcId = null; }
        };
        return;
      }

      // rAF fallback — skip draw when tab is hidden to avoid burst on refocus
      const draw = () => {
        if (!this.running) return;
        this.raf = requestAnimationFrame(draw);
        if (document.visibilityState === "hidden") return;
        if (!v || v.readyState < 2 || v.paused || v.ended || v.videoWidth === 0) return;
        const { videoWidth: w, videoHeight: h } = v;
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w; this.canvas.height = h;
        }
        try { this.ctx.drawImage(v, 0, 0, w, h); } catch (_) { return; }
        if (this.canvas.style.opacity !== "1") {
          this.canvas.style.opacity = "1";
          L(`${this.id}: ✓ visible (${w}×${h})`);
        }
      };
      this.raf         = requestAnimationFrame(draw);
      this._stopMirror = () => { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; } };
    }

    async play(container, m3u8Url) {
      this.destroy();
      this._mount(container);
      this.isInjecting = true;
      try {
        const resp = await fetch(`${PROXY_BASE}/transcode?url=${encodeURIComponent(m3u8Url)}`);
        if (!resp.ok) {
          E(`${this.id}: proxy error ${resp.status}:`, await resp.text().catch(() => ""));
          this.isInjecting = false;
          return false;
        }

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
        L(`${this.id}: WebM received (${(totalBytes / 1024).toFixed(0)} KB)`);

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
      } catch (e) {
        E(`${this.id}: play failed:`, e.message);
        this.destroy();
        return false;
      }
    }
  }

  let currentUri = null;
  let lastM3u8   = null;
  let proxyOk    = false;
  const playerNPV = new ProxyPlayer("animart-npv");
  const playerSL  = new ProxyPlayer("animart-sl");

  async function fetchM3u8(artist, album, title) {
    const params = new URLSearchParams({ artist: artist || "", album: album || "", title: title || "" });
    try {
      const resp = await fetch(`${PROXY_BASE}/artwork?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) { E(`/artwork error: ${resp.status}`); return null; }
      const json = await resp.json();
      return json.m3u8 || null;
    } catch (e) { E("fetchM3u8:", e.message); return null; }
  }

  const findNpv = () =>
    document.querySelector(".MediaImageContainer") ||
    document.querySelector("[data-testid='cover-art-image']")?.closest("[data-testid='cover-art']") ||
    document.querySelector("[data-testid='now-playing-widget'] [data-testid='cover-art']") ||
    document.querySelector(".main-coverSlotExpanded-container") || null;

  const findSL = () => {
    const root =
      document.querySelector("#SpicyLyricsPage") ||
      document.querySelector(".spicylyrics-page") ||
      document.querySelector("[class*='SpicyLyrics']") ||
      document.querySelector("[data-spicylyrics]") ||
      document.querySelector(".Root__fullscreen-page [class*='SpicyLyrics']") ||
      document.querySelector(".Root__fullscreen-page #SpicyLyricsPage") ||
      document.querySelector("[class*='fullscreen'] [class*='SpicyLyrics']") ||
      document.querySelector("[class*='fullscreen'] #SpicyLyricsPage");
    if (!root) return null;
    return (
      root.querySelector(".MediaImageContainer") ||
      root.querySelector("[data-testid='cover-art']") ||
      root.querySelector("[data-testid='cover-art-image']")?.closest("[data-testid='cover-art']") ||
      root.querySelector(".cover-art") ||
      root.querySelector("[class*='CoverArt']") ||
      root
    );
  };

  async function tryInject(player, finder, label, m3u8, tries = 20) {
    if (player.isInjecting) return false;
    if (player.isActive())  return true;
    player.isInjecting = true;
    try {
      for (let i = 0; i < tries; i++) {
        const el = finder();
        if (el) {
          const ok = await player.play(el, m3u8);
          if (ok) L(`✓ ${label}`);
          return ok;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      L(`⚠ ${label}: container not found`);
    } finally {
      player.isInjecting = false;
    }
    return false;
  }

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
    if (!proxyOk) { E("Proxy not running! Start with: node animart-proxy.js"); return; }

    const m3u8 = await fetchM3u8(artist, album, title);
    if (!m3u8) { L("No animated artwork for this track"); return; }
    lastM3u8 = m3u8;

    tryInject(playerNPV, findNpv, "Now Bar",      m3u8);
    tryInject(playerSL,  findSL,  "Spicy Lyrics", m3u8);
  }

  let observerTimer  = null;
  let lastFullscreen = !!document.fullscreenElement;

  function scheduleReInject(delay = 300) {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      if (!lastM3u8 || !proxyOk) return;
      if (!playerNPV.isActive() && !playerNPV.isInjecting)
        tryInject(playerNPV, findNpv, "NPV (re)", lastM3u8, 8);
      if (!playerSL.isActive() && !playerSL.isInjecting)
        tryInject(playerSL, findSL, "SL (re)", lastM3u8, 8);
    }, delay);
  }

  // Native fullscreen API
  document.addEventListener("fullscreenchange", () => {
    const isFs = !!document.fullscreenElement;
    if (isFs !== lastFullscreen) {
      lastFullscreen = isFs;
      L(`Fullscreen ${isFs ? "entered" : "exited"} — re-injecting`);
      playerNPV.destroy();
      playerSL.destroy();
      scheduleReInject(400);
    }
  });

  // Spicetify CSS-based fullscreen (no native fullscreen API event)
  const fsObserver = new MutationObserver(() => {
    const isFs =
      document.documentElement.classList.contains("fullscreen") ||
      document.body.classList.contains("fullscreen") ||
      !!document.querySelector(".Root__fullscreen-page") ||
      !!document.querySelector("[class*='fullscreen-mode']");
    if (isFs !== lastFullscreen) {
      lastFullscreen = isFs;
      L(`Spicetify fullscreen ${isFs ? "entered" : "exited"} — re-injecting`);
      playerNPV.destroy();
      playerSL.destroy();
      scheduleReInject(400);
    }
  });
  fsObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  fsObserver.observe(document.body,            { attributes: true, attributeFilter: ["class"] });

  // General DOM observer — re-inject if canvas gets removed
  const observer = new MutationObserver((mutations) => {
    if (!lastM3u8 || !proxyOk) return;
    const relevant = mutations.some(m => {
      for (const node of m.addedNodes)   { if (node.dataset?.animart) return false; }
      for (const node of m.removedNodes) {
        if (node.id === "animart-npv-canvas" || node.id === "animart-sl-canvas") return true;
      }
      const t = m.target;
      if (t?.dataset?.animart || t?.id?.startsWith("animart-")) return false;
      return true;
    });
    if (relevant) scheduleReInject(300);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  L("v2 — fullscreen fix + rVFC + rAF fallback + VP9");
  proxyOk = await isProxyAlive();
  if (proxyOk) L("✓ Proxy running at localhost:7799");
  else { E("Proxy not running!"); E("Start with: node animart-proxy.js"); }

  Spicetify.Player.addEventListener("songchange", onSongChange);
  await onSongChange();
  L("Ready ✓");

})();
