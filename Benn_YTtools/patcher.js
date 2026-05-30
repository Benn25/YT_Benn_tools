/**
 * Benn YT Tools — patcher.js  (MAIN world)
 *
 * Music detection (confirmed via console diagnostics):
 *   The music marker `yt-video-attribute-view-model` lives in the card's
 *   metadata area (song/artist chip BELOW the thumbnail), not under the
 *   thumbnail/cursor — so point-based checks never reached it. Correct
 *   approach: locate the CARD that owns the hovered preview, then search the
 *   whole card subtree for the music chip wherever it sits.
 *
 * Music previews:  force-unmuted (no mute button → no desync) + locked to 1×.
 * Regular previews: vanilla mute (in-card button stays in sync) + previewSpeed.
 * Returning to a regular card: isMusic() flips false instantly, so regular
 * cards get their own mute/speed naturally (nothing to "revert").
 */
(function () {

  const DEBUG          = true;   // logs one line per preview start; set false to silence
  const DEFAULT_VOLUME = 0.4;
  const POLL_MS        = 120;

  let scrubStep    = 5;
  let speedStep    = 0.2;
  let previewSpeed = 1.5;

  const origMuted   = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  const origVolume  = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const origSetAttr = Element.prototype.setAttribute;

  const PREV_SEL  = 'ytd-video-preview,ytd-moving-thumbnail-renderer,yt-video-attribute-view-model,#video-preview';
  // The card container that owns a preview.
  const CARD_SEL  = 'yt-lockup-view-model,ytd-rich-item-renderer,ytd-rich-grid-media,' +
                    'ytd-compact-video-renderer,ytd-video-renderer,ytd-grid-video-renderer';
  // The music chip that appears inside a music card's metadata.
  const MUSIC_SEL = 'yt-video-attribute-view-model,ytmusic-video-attribute-view-model';

  const inPrev = el => el && el.isConnected && !!el.closest(PREV_SEL);

  // ── Settings bridge ───────────────────────────────────────────────────────
  window.addEventListener('message', e => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== '__benn_yt_settings__') return;
    const { scrubStep: s, speedStep: sp, previewSpeed: ps } = e.data;
    if (typeof s  === 'number' && s  >= 1    && s  <= 15)  scrubStep    = s;
    if (typeof sp === 'number' && sp >= 0.05 && sp <= 0.5) speedStep    = sp;
    if (typeof ps === 'number' && ps >= 0.5  && ps <= 3)   previewSpeed = ps;
  });

  // ── Cursor tracking ───────────────────────────────────────────────────────
  let mx = -1, my = -1;
  const onMove = e => { mx = e.clientX; my = e.clientY; };
  document.addEventListener('mousemove',   onMove, true);
  document.addEventListener('pointermove', onMove, true);

  // Find the card that owns this preview video. The preview overlay may be a
  // relocated singleton, so try (1) the video's own ancestors, then (2) the
  // element stack at the video's centre, then (3) the cursor location.
  function findCard(v) {
    if (v && v.closest) { const c = v.closest(CARD_SEL); if (c) return c; }
    const pts = [];
    if (v && v.getBoundingClientRect) {
      const r = v.getBoundingClientRect();
      if (r.width && r.height) pts.push([r.left + r.width / 2, r.top + r.height / 2]);
    }
    if (mx >= 0) pts.push([mx, my]);
    for (const [x, y] of pts) {
      let stack;
      try { stack = document.elementsFromPoint(x, y); } catch (_) { stack = []; }
      for (const el of stack) {
        const c = el.closest && el.closest(CARD_SEL);
        if (c) return c;
      }
    }
    return null;
  }

  function detectMusic(v) {
    const card = findCard(v);
    let marker = null;
    if (card) { try { marker = card.querySelector(MUSIC_SEL); } catch (_) {} }
    return { music: !!marker, card, marker };
  }

  const isMusic = v => detectMusic(v).music;

  // ── Music-only mute patch (block synchronously, never oscillate) ──────────
  Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
    get() { return origMuted.get.call(this); },
    set(val) {
      if (val && inPrev(this) && isMusic(this)) {
        origMuted.set.call(this, false);
        if (origVolume.get.call(this) < 0.01) origVolume.set.call(this, DEFAULT_VOLUME);
        return;
      }
      origMuted.set.call(this, val);
    }, configurable: true,
  });

  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    get() { return origVolume.get.call(this); },
    set(val) {
      if (val < 0.01 && inPrev(this) && isMusic(this)) return;
      origVolume.set.call(this, val);
    }, configurable: true,
  });

  Element.prototype.setAttribute = function (n, v) {
    if (n === 'muted' && this instanceof HTMLVideoElement && inPrev(this) && isMusic(this)) return;
    return origSetAttr.call(this, n, v);
  };

  // Polling backstop: keep currently-playing music previews unmuted + at 1×.
  setInterval(() => {
    document.querySelectorAll(PREV_SEL + ' video').forEach(v => {
      if (v.paused || v.ended) return;
      if (!isMusic(v)) return;
      if (origMuted.get.call(v)) origMuted.set.call(v, false);
      if (origVolume.get.call(v) < 0.01) origVolume.set.call(v, DEFAULT_VOLUME);
      if (v.playbackRate !== 1) v.playbackRate = 1;
    });
  }, POLL_MS);

  // ── Default preview playback speed ────────────────────────────────────────
  document.addEventListener('play', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !inPrev(v)) return;
    const d = detectMusic(v);
    v.playbackRate = d.music ? 1 : previewSpeed;
    if (DEBUG) {
      console.log('[BennYT] play — music=' + d.music +
                  ' card=' + (d.card ? d.card.tagName.toLowerCase() : 'none') +
                  ' marker=' + (d.marker ? d.marker.tagName.toLowerCase() : 'none') +
                  ' rate=' + v.playbackRate +
                  ' musicCardsInDOM=' + document.querySelectorAll(MUSIC_SEL).length);
    }
  }, true);

  // ── Wheel shortcuts ───────────────────────────────────────────────────────
  function findPreviewVideo(e) {
    const path = e.composedPath ? e.composedPath() : [];
    for (const el of path) if (el && el.tagName === 'VIDEO') return el;
    for (const el of path) {
      if (el && el.querySelector) { const v = el.querySelector('video'); if (v) return v; }
    }
    for (const v of document.querySelectorAll(PREV_SEL + ' video')) {
      if (!v.paused && !v.ended && v.readyState >= 2) return v;
    }
    for (const v of document.querySelectorAll('video')) {
      if (!v.paused && !v.ended && v.readyState >= 2 && v.duration) return v;
    }
    return null;
  }

  let flashEl = null, flashTimer = null;
  function flash(text, x, y) {
    if (!document.body) return;
    if (!flashEl) {
      flashEl = document.createElement('div');
      flashEl.setAttribute('style',
        'position:fixed;top:0;left:0;transform:translate(-50%,-50%);' +
        'background:rgba(0,0,0,0.82);color:#fff;padding:10px 20px;border-radius:10px;' +
        'font:700 22px Roboto,Arial,sans-serif;z-index:2147483647;pointer-events:none;' +
        'transition:opacity 0.25s;opacity:0');
      document.body.appendChild(flashEl);
    }
    flashEl.style.top  = (y || window.innerHeight / 2) + 'px';
    flashEl.style.left = (x || window.innerWidth  / 2) + 'px';
    flashEl.textContent = text;
    flashEl.style.opacity = '1';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (flashEl) flashEl.style.opacity = '0'; }, 600);
  }

  function onWheel(e) {
    if (!e.shiftKey) return;
    const v = findPreviewVideo(e);
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    const up = e.deltaY < 0;
    if (e.altKey) {
      v.currentTime = Math.max(0, Math.min(v.duration || Infinity,
        v.currentTime + (up ? scrubStep : -scrubStep)));
      flash((up ? '+' : '−') + scrubStep + 's', e.clientX, e.clientY);
      return;
    }
    // Speed branch. Music previews are LOCKED at 1× — ignore entirely.
    if (isMusic(v)) {
      if (v.playbackRate !== 1) v.playbackRate = 1;
      return;
    }
    const newRate = Math.max(0.1,
      Math.round((v.playbackRate + (up ? speedStep : -speedStep)) * 100) / 100);
    v.playbackRate = newRate;
    flash(newRate.toFixed(2) + '×', e.clientX, e.clientY);
    previewSpeed = newRate;
    window.postMessage({ type: '__benn_yt_save__', previewSpeed: newRate }, '*');
  }

  document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('wheel',   onWheel, { passive: false, capture: true });

})();
