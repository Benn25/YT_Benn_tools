/**
 * YT Hover Sound — patcher.js  v2.4.0
 *
 * All previews are force-unmuted (fixes music videos with no button).
 * User can still click YouTube's native mute button on regular videos.
 * Music videos are always unmuted (no button exists, user accepted this).
 *
 * Detection strategy: behavioral, not structural.
 * - YouTube auto-muting → blocked (force unmuted)
 * - User clicking a button in the card/preview area → allowed
 *
 * Wheel shortcuts (any preview):
 *   Shift + wheel        → playback speed ±0.2
 *   Shift + Alt + wheel  → scrub ±10s
 */
(function () {

  const DEFAULT_VOLUME = 0.4;
  const POLL_MS    = 120;
  const SPEED_STEP = 0.2;
  const SCRUB_STEP = 10;

  const origMuted   = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  const origVolume  = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const origSetAttr = Element.prototype.setAttribute;

  const PREV_SEL = 'ytd-video-preview,ytd-moving-thumbnail-renderer,yt-video-attribute-view-model,#video-preview';
  const CARD_SEL = 'ytd-rich-item-renderer,ytd-compact-video-renderer,ytd-video-renderer,ytd-grid-video-renderer';

  const inPrev = el => el.isConnected && !!el.closest(PREV_SEL);

  // ── User-click detection ──────────────────────────────────────────────────
  // We only allow muting when the user clicked something in the card/preview
  // area. This distinguishes user intent from YouTube's auto-muting.
  let recentClick  = false;
  let userHasMuted = false;  // user explicitly muted this preview
  let lastCard     = null;

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

  // Reset mute state when hovering a new card
  function cardFromPath(e) {
    const path = e.composedPath ? e.composedPath() : [];
    for (const el of path) {
      try { if (el.matches && el.matches(CARD_SEL)) return el; } catch (_) {}
    }
    return null;
  }
  document.addEventListener('mouseover', e => {
    const card = cardFromPath(e);
    if (card && card !== lastCard) {
      lastCard     = card;
      userHasMuted = false;   // new preview: reset state
    }
  }, true);

  // ── Audio patches ─────────────────────────────────────────────────────────
  Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
    get() { return origMuted.get.call(this); },
    set(val) {
      if (inPrev(this)) {
        if (val) {
          if (recentClick) {
            // User clicked → honour the mute
            userHasMuted = true;
            origMuted.set.call(this, true);
          } else if (userHasMuted) {
            // YouTube re-muting a video the user already muted → honour it
            origMuted.set.call(this, true);
          } else {
            // YouTube auto-muting (music or initial state) → block it
            origMuted.set.call(this, false);
            if (origVolume.get.call(this) < 0.01) origVolume.set.call(this, DEFAULT_VOLUME);
          }
        } else {
          // Unmuting → always allow, clear user-muted flag
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
        if (!recentClick && !userHasMuted) return; // block silent trick
      }
      origVolume.set.call(this, val);
    }, configurable: true,
  });

  Element.prototype.setAttribute = function (n, v) {
    if (n === 'muted' && this instanceof HTMLVideoElement && inPrev(this)) {
      if (!recentClick && !userHasMuted) return; // block
    }
    return origSetAttr.call(this, n, v);
  };

  // Polling: keeps force-unmuting unless user has muted
  setInterval(() => {
    if (userHasMuted) return;
    document.querySelectorAll(PREV_SEL + ' video').forEach(v => {
      if (origMuted.get.call(v))         origMuted.set.call(v, false);
      if (origVolume.get.call(v) < 0.01) origVolume.set.call(v, DEFAULT_VOLUME);
    });
  }, POLL_MS);

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
      v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + (up ? SCRUB_STEP : -SCRUB_STEP)));
      flash((up ? '+' : '−') + SCRUB_STEP + 's', e.clientX, e.clientY);
    } else {
      v.playbackRate = Math.max(0.1, Math.round((v.playbackRate + (up ? SPEED_STEP : -SPEED_STEP)) * 10) / 10);
      flash(v.playbackRate.toFixed(1) + '×', e.clientX, e.clientY);
    }
  }

  document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('wheel',   onWheel, { passive: false, capture: true });

})();
