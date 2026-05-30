/**
 * Benn YT Tools — patcher.js
 *
 * Runs in MAIN world. Receives settings from content.js via namespaced
 * postMessage (__benn_yt_settings__); sends save requests via __benn_yt_save__.
 *
 * Mute behaviour: fully vanilla. We do NOT override the muted/volume
 * properties anymore — that was the cause of the audio/button desync (and an
 * earlier feedback-loop CPU meltdown). Previews start muted like vanilla
 * YouTube; the user clicks unmute, and YouTube keeps audio + button in sync
 * and remembers the choice across previews natively.
 *
 * Preview playback speed:
 *   - Regular video previews start at `previewSpeed` (configurable default).
 *   - MUSIC previews are completely excluded: they always start at 1×.
 *   - Shift+wheel adjusts speed live. On regular previews the new rate is
 *     saved as the default; on music previews it's applied temporarily and
 *     never saved.
 *
 * Wheel shortcuts:
 *   Shift + wheel        → playback speed ± speedStep
 *   Shift + Alt + wheel  → scrub ± scrubStep seconds
 */
(function () {

  // Defaults match DEFAULTS in content.js; overwritten by postMessage on load.
  let scrubStep    = 5;
  let speedStep    = 0.2;
  let previewSpeed = 1.5;

  const PREV_SEL  = 'ytd-video-preview,ytd-moving-thumbnail-renderer,yt-video-attribute-view-model,#video-preview';
  const CARD_SEL  = 'ytd-rich-item-renderer,ytd-compact-video-renderer,ytd-video-renderer,ytd-grid-video-renderer';
  const MUSIC_SEL = 'yt-video-attribute-view-model';

  const inPrev = el => el && el.isConnected && !!el.closest(PREV_SEL);

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

  // ── Music-card hover tracking ─────────────────────────────────────────────
  // Preview <video> elements live in a shared overlay, not inside the card, so
  // video.closest(MUSIC_SEL) is unreliable. Instead we track whether the mouse
  // is currently over a music card vs a regular card. The flag stays put when
  // the cursor is over neutral page chrome, so it reflects the card that owns
  // whatever preview is currently playing.
  let hoverIsMusic = false;
  document.addEventListener('mouseover', e => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest(MUSIC_SEL))      hoverIsMusic = true;
    else if (t.closest(CARD_SEL))  hoverIsMusic = false;
  }, true);

  // True if the given preview video belongs to a music card.
  const isMusic = v => (v && v.closest && !!v.closest(MUSIC_SEL)) || hoverIsMusic;

  // ── Default preview playback speed ────────────────────────────────────────
  document.addEventListener('play', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !inPrev(v)) return;
    // Music previews are excluded from the speed-up system: always 1×.
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
      // Save new default only for regular previews. Music previews are
      // excluded: the change applies temporarily but is never memorised.
      if (inPrev(v) && !isMusic(v)) {
        previewSpeed = newRate;
        window.postMessage({ type: '__benn_yt_save__', previewSpeed: newRate }, '*');
      }
    }
  }

  document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('wheel',   onWheel, { passive: false, capture: true });

})();
