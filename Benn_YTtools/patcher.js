/**
 * Benn YT Tools — patcher.js
 *
 * Runs in MAIN world (required to patch HTMLMediaElement.prototype).
 * Cannot access chrome.storage directly; receives settings from content.js
 * via namespaced postMessage (__benn_yt_settings__).
 * Sends save requests back via __benn_yt_save__.
 *
 * Mute logic: block synchronously (never oscillate the property — see skill notes).
 * Mute state persists across cards: last user choice carries forward.
 *
 * Wheel shortcuts:
 *   Shift + wheel        → playback speed ± speedStep (saves if non-music preview)
 *   Shift + Alt + wheel  → scrub ± scrubStep seconds
 */
(function () {

  const DEFAULT_VOLUME  = 0.4;
  const POLL_MS         = 120;

  // Defaults match DEFAULTS in content.js; overwritten by postMessage on load.
  let scrubStep    = 5;
  let speedStep    = 0.2;
  let previewSpeed = 1.5;

  const origMuted   = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  const origVolume  = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const origSetAttr = Element.prototype.setAttribute;

  const PREV_SEL = 'ytd-video-preview,ytd-moving-thumbnail-renderer,yt-video-attribute-view-model,#video-preview';
  const CARD_SEL = 'ytd-rich-item-renderer,ytd-compact-video-renderer,ytd-video-renderer,ytd-grid-video-renderer';

  const inPrev       = el => el.isConnected && !!el.closest(PREV_SEL);
  const isMusicPrev  = el => !!el.closest('yt-video-attribute-view-model');

  // ── Settings bridge ───────────────────────────────────────────────────────
  window.addEventListener('message', e => {
    if (e.source !== window) return;
    if (!e.data) return;
    if (e.data.type === '__benn_yt_settings__') {
      const { scrubStep: s, speedStep: sp, previewSpeed: ps } = e.data;
      if (typeof s  === 'number' && s  >= 1    && s  <= 15)  scrubStep    = s;
      if (typeof sp === 'number' && sp >= 0.05 && sp <= 0.5) speedStep    = sp;
      if (typeof ps === 'number' && ps >= 0.5  && ps <= 3)   previewSpeed = ps;
    }
  });

  // ── User-click detection ──────────────────────────────────────────────────
  let recentClick  = false;
  let userHasMuted = false;

  document.addEventListener('click', e => {
    const path = e.composedPath ? e.composedPath() : [];
    const inArea = path.some(el => {
      try { return el.matches && (el.matches(CARD_SEL) || el.matches(PREV_SEL)); } catch (_) {}
    });
    if (inArea) {
      recentClick = true;
      setTimeout(() => { recentClick = false; }, 250);
    }
  }, true);

  // ── Button sync (guarded, loop-proof) ────────────────────────────────────
  let syncing = false;
  function syncMuteButton(v) {
    if (syncing) return;
    syncing = true;
    try { v.dispatchEvent(new Event('volumechange', { bubbles: true, composed: true })); } catch (_) {}
    syncing = false;
  }

  // ── Audio patches ─────────────────────────────────────────────────────────
  Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
    get() { return origMuted.get.call(this); },
    set(val) {
      if (inPrev(this)) {
        if (val) {
          if (recentClick || userHasMuted) {
            if (recentClick) userHasMuted = true;
            origMuted.set.call(this, true);
          } else {
            // YouTube auto-muting → block synchronously (never oscillate)
            const vid = this;
            origMuted.set.call(vid, false);
            if (origVolume.get.call(vid) < 0.01) origVolume.set.call(vid, DEFAULT_VOLUME);
            // Sync the mute button after YouTube's handler chain completes
            setTimeout(() => syncMuteButton(vid), 0);
          }
        } else {
          userHasMuted = false;
          origMuted.set.call(this, false);
        }
        return;
      }
      origMuted.set.call(this, val);
    }, configurable: true,
  });

  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    get() { return origVolume.get.call(this); },
    set(val) {
      if (val < 0.01 && inPrev(this)) {
        if (!recentClick && !userHasMuted) return;
      }
      origVolume.set.call(this, val);
    }, configurable: true,
  });

  Element.prototype.setAttribute = function (n, v) {
    if (n === 'muted' && this instanceof HTMLVideoElement && inPrev(this)) {
      if (!recentClick && !userHasMuted) return;
    }
    return origSetAttr.call(this, n, v);
  };

  // Polling backstop: re-enforces unmute; nudges button when it actually flips.
  setInterval(() => {
    if (userHasMuted) return;
    document.querySelectorAll(PREV_SEL + ' video').forEach(v => {
      let flipped = false;
      if (origMuted.get.call(v)) { origMuted.set.call(v, false); flipped = true; }
      if (origVolume.get.call(v) < 0.01) origVolume.set.call(v, DEFAULT_VOLUME);
      if (flipped) syncMuteButton(v);
    });
  }, POLL_MS);

  // ── Default preview playback speed ───────────────────────────────────────
  document.addEventListener('play', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !inPrev(v)) return;
    v.playbackRate = isMusicPrev(v) ? 1 : previewSpeed;
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
    } else {
      const newRate = Math.max(0.1,
        Math.round((v.playbackRate + (up ? speedStep : -speedStep)) * 100) / 100);
      v.playbackRate = newRate;
      flash(newRate.toFixed(2) + '×', e.clientX, e.clientY);
      // Save new default only for regular (non-music) preview videos
      if (inPrev(v) && !isMusicPrev(v)) {
        previewSpeed = newRate;
        window.postMessage({ type: '__benn_yt_save__', previewSpeed: newRate }, '*');
      }
    }
  }

  document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('wheel',   onWheel, { passive: false, capture: true });

})();
