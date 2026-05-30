/**
 * Benn YT Tools — patcher.js
 *
 * Runs in MAIN world. Receives settings from content.js via
 * __benn_yt_settings__; sends save requests via __benn_yt_save__.
 *
 * Mute behaviour:
 *   - Regular card previews: fully vanilla (user clicks the in-card
 *     mute button; button + audio always agree; no property override).
 *   - Music card previews (yt-video-attribute-view-model): force-unmuted.
 *     These cards have NO visible mute button, so there is nothing to
 *     desync. Audio is blocked synchronously; never oscillate.
 *
 * Preview playback speed:
 *   - Regular previews start at `previewSpeed`; Shift+wheel saves the
 *     new rate.
 *   - Music previews are fully excluded: always 1×; Shift+wheel applies
 *     temporarily but is never saved.
 *
 * Wheel shortcuts:
 *   Shift + wheel        → playback speed ± speedStep
 *   Shift + Alt + wheel  → scrub ± scrubStep seconds
 */
(function () {

  const DEFAULT_VOLUME = 0.4;
  const POLL_MS        = 120;

  // Defaults overwritten by postMessage on load.
  let scrubStep    = 5;
  let speedStep    = 0.2;
  let previewSpeed = 1.5;

  const origMuted   = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  const origVolume  = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const origSetAttr = Element.prototype.setAttribute;

  const PREV_SEL  = 'ytd-video-preview,ytd-moving-thumbnail-renderer,yt-video-attribute-view-model,#video-preview';
  const CARD_SEL  = 'ytd-rich-item-renderer,ytd-compact-video-renderer,ytd-video-renderer,ytd-grid-video-renderer';
  const MUSIC_SEL = 'yt-video-attribute-view-model';

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

  // ── Music-card hover tracking ─────────────────────────────────────────────
  // Preview <video> elements live in a shared overlay, so
  // video.closest(MUSIC_SEL) is always null. Instead, track whether the
  // mouse just entered a music card vs a regular card.
  //
  // mouseenter + matches (exact element, not ancestors) is used so that
  // hovering over children inside a music card does NOT reset the flag to
  // false. The flag only changes when the mouse crosses a card boundary.
  let hoverIsMusic = false;
  document.addEventListener('mouseenter', e => {
    const t = e.target;
    if (!t || !t.matches) return;
    try {
      if      (t.matches(MUSIC_SEL)) hoverIsMusic = true;
      else if (t.matches(CARD_SEL))  hoverIsMusic = false;
    } catch (_) {}
  }, true);

  // True when the video (or current hover context) is a music preview.
  const isMusic = v => (v && v.closest && !!v.closest(MUSIC_SEL)) || hoverIsMusic;

  // ── Music-only mute patch ────────────────────────────────────────────────
  // Only music previews are force-unmuted (no button → no desync possible).
  // Regular previews pass through to YouTube vanilla — the in-card mute
  // button stays in sync naturally.
  // IMPORTANT: block synchronously, never oscillate (see SKILL pitfall note).
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

  // Polling backstop for music previews: catches any mute that slipped
  // through before hoverIsMusic was set.
  setInterval(() => {
    if (!hoverIsMusic) return;
    document.querySelectorAll(PREV_SEL + ' video').forEach(v => {
      if (origMuted.get.call(v)) origMuted.set.call(v, false);
      if (origVolume.get.call(v) < 0.01) origVolume.set.call(v, DEFAULT_VOLUME);
    });
  }, POLL_MS);

  // ── Default preview playback speed ────────────────────────────────────────
  document.addEventListener('play', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !inPrev(v)) return;
    v.playbackRate = isMusic(v) ? 1 : previewSpeed;
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
      // Music previews: apply temporarily, never save.
      if (inPrev(v) && !isMusic(v)) {
        previewSpeed = newRate;
        window.postMessage({ type: '__benn_yt_save__', previewSpeed: newRate }, '*');
      }
    }
  }

  document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('wheel',   onWheel, { passive: false, capture: true });

})();
