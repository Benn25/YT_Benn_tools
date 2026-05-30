/**
 * Benn YT Tools — patcher.js  (MAIN world)
 *
 * Music-vs-regular detection — THE HARD PART:
 *   On hover, YouTube floats a shared preview overlay ON TOP of the card.
 *   The cursor therefore sits over that overlay (identical for music and
 *   regular videos), NOT over the card element underneath. So closest() on
 *   the hovered element / the <video> never finds the music marker.
 *   Fix: document.elementsFromPoint(cursor) sees THROUGH the overlay and
 *   returns the full stack, including the card below — so we can find the
 *   music marker there.
 *
 * Mute:
 *   - Music previews (no mute button) → force-unmuted (block synchronously,
 *     never oscillate).
 *   - Regular previews → vanilla (their in-card mute button stays in sync).
 *
 * Speed:
 *   - Regular previews → previewSpeed; Shift+wheel saves the new rate.
 *   - Music previews → always 1×; Shift+wheel applies temporarily, never saved.
 */
(function () {

  const DEBUG          = true;   // logs one line per preview start; set false to silence
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
  // Markers that identify a MUSIC card/preview (checked under the cursor).
  const MUSIC_SEL = 'yt-video-attribute-view-model,ytmusic-video-attribute-view-model,a[href*="music.youtube.com"]';

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

  // ── Cursor tracking + music detection (sees through the preview overlay) ──
  let mx = -1, my = -1;
  const onMove = e => { mx = e.clientX; my = e.clientY; };
  document.addEventListener('mousemove',   onMove, true);
  document.addEventListener('pointermove', onMove, true);

  function pointerStack() {
    if (mx < 0) return [];
    try { return document.elementsFromPoint(mx, my); } catch (_) { return []; }
  }

  // A preview is "music" if the music marker is found anywhere in the
  // cursor's element stack (the card sitting under the overlay), or — as a
  // cheap fallback — as an ancestor of the <video> itself.
  function isMusic(v) {
    if (v && v.closest && v.closest(MUSIC_SEL)) return true;
    return pointerStack().some(el => el.closest && el.closest(MUSIC_SEL));
  }

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

  // Polling backstop: keep music previews unmuted.
  setInterval(() => {
    const stackIsMusic = pointerStack().some(el => el.closest && el.closest(MUSIC_SEL));
    if (!stackIsMusic) return;
    document.querySelectorAll(PREV_SEL + ' video').forEach(v => {
      if (origMuted.get.call(v)) origMuted.set.call(v, false);
      if (origVolume.get.call(v) < 0.01) origVolume.set.call(v, DEFAULT_VOLUME);
    });
  }, POLL_MS);

  // ── Default preview playback speed ────────────────────────────────────────
  document.addEventListener('play', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !inPrev(v)) return;
    const music = isMusic(v);
    v.playbackRate = music ? 1 : previewSpeed;
    if (DEBUG) {
      const stack = pointerStack()
        .map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''))
        .slice(0, 12).join(' < ');
      console.log('[BennYT] preview play — music=' + music + ' rate=' + v.playbackRate +
                  ' | stack: ' + stack);
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
