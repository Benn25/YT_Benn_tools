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

  const inPrev = el => el.isConnected && !!el.closest(PREV_SEL);

  // ── Music detection (geometric) ───────────────────────────────────────────
  // The preview <video> is a SHARED overlay, never a DOM child of the music
  // card, so closest()/querySelector from the video never find the music chip.
  // But the overlay is positioned over the hovered card's thumbnail. So: find
  // each music card (via its yt-video-attribute-view-model chip → owning card)
  // and test whether the playing preview's centre falls inside that card's
  // rectangle. The chip itself sits in the metadata area (below the thumbnail),
  // which is why earlier chip-overlap checks failed — we must use the CARD rect.
  const MUSIC_CHIP = 'yt-video-attribute-view-model,ytmusic-video-attribute-view-model';

  function isMusicVideo(v) {
    if (!v || !v.getBoundingClientRect) return false;
    const vr = v.getBoundingClientRect();
    if (!vr.width || !vr.height) return false;
    const cx = vr.left + vr.width / 2;
    const cy = vr.top + vr.height / 2;
    for (const chip of document.querySelectorAll(MUSIC_CHIP)) {
      const card = chip.closest(CARD_SEL) || chip.parentElement;
      if (!card) continue;
      const cr = card.getBoundingClientRect();
      if (cr.width && cr.height &&
          cx >= cr.left && cx <= cr.right && cy >= cr.top && cy <= cr.bottom) {
        return true;
      }
    }
    return false;
  }

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
  // Only a click on an actual mute control means "the user wants silence".
  // Every other click on a card is the user OPENING the video: treat that as
  // a teardown instead. Counting it as a mute (what we used to do) had two
  // bad effects — the mute YouTube applies while navigating was recorded as
  // the user's choice, silencing every later preview, and the preview kept
  // playing over the watch page.
  const MUTE_BTN_SEL = 'ytm-mute-button,yt-mute-toggle-button,' +
                       '.ytmMuteButtonHost,.ytmMuteButtonButton,.ytp-mute-button';
  let recentClick  = false;
  let userHasMuted = false;

  function pathHas(path, sel) {
    for (const el of path) {
      try { if (el.matches && el.matches(sel)) return true; } catch (_) {}
    }
    return false;
  }

  document.addEventListener('click', e => {
    const path = e.composedPath ? e.composedPath() : [];
    if (!pathHas(path, CARD_SEL + ',' + PREV_SEL)) return;
    if (pathHas(path, MUTE_BTN_SEL)) {
      recentClick = true;
      setTimeout(() => { recentClick = false; }, 250);
    } else {
      // Opening the video — no preview may outlive the click.
      setTimeout(stopAllPreviews, 0);
    }
  }, true);

  // ── Player-state sync (guarded, loop-proof) ──────────────────────────────
  // Forcing element.muted = false leaves YouTube's own player object still
  // believing it is muted (verified: isMuted() === true while the element
  // plays audio). That stale belief is what YouTube carries over to the watch
  // page, which is why a clicked video sometimes starts muted. unMute() puts
  // the player object back in sync; the synthetic volumechange stays as the
  // fallback that at least refreshes the mute button.
  let syncing = false;

  function playerOf(v) {
    try { return v.closest ? v.closest('.html5-video-player') : null; } catch (_) { return null; }
  }

  function syncMuteButton(v) {
    if (syncing) return;
    syncing = true;
    const mp = playerOf(v);
    try {
      if (mp && typeof mp.unMute === 'function' &&
          (typeof mp.isMuted !== 'function' || mp.isMuted())) {
        mp.unMute();
      } else {
        v.dispatchEvent(new Event('volumechange', { bubbles: true, composed: true }));
      }
    } catch (_) {
      try { v.dispatchEvent(new Event('volumechange', { bubbles: true, composed: true })); } catch (__) {}
    }
    syncing = false;
  }

  // ── Preview lifecycle guard ──────────────────────────────────────────────
  // YouTube only tears a preview down when the pointer LEAVES the card, so if
  // the pointer never moves — Ctrl+Tab to another tab, alt-tab to another app,
  // or simply parking the mouse on the thumbnail — the preview plays on.
  // YouTube keeps previews muted so it never notices; we unmute them, so it
  // means audio from a thumbnail nobody is looking at (and a second soundtrack
  // over the video you then open). Enforce the rule ourselves: a preview may
  // only play while the window is focused, the tab visible, and the pointer
  // over a card or preview.
  const STRAY_GRACE_MS = 700;   // previews start playing before they are shown

  let ptrX = -1, ptrY = -1;
  document.addEventListener('mousemove', e => { ptrX = e.clientX; ptrY = e.clientY; }, true);
  // relatedTarget === null ⇒ the pointer left the window entirely.
  document.addEventListener('mouseout', e => { if (!e.relatedTarget) ptrX = ptrY = -1; }, true);

  function pointerOverCard() {
    if (ptrX < 0) return false;
    let el = null;
    try { el = document.elementFromPoint(ptrX, ptrY); } catch (_) {}
    if (!el || !el.closest) return false;
    try { return !!(el.closest(PREV_SEL) || el.closest(CARD_SEL)); } catch (_) { return false; }
  }

  function previewsAllowed() {
    return !document.hidden && document.hasFocus() && pointerOverCard();
  }

  function stopPreview(v, hard) {
    const mp = playerOf(v);
    try {
      if (mp && typeof mp.stopVideo === 'function')       mp.stopVideo();   // YouTube's own teardown
      else if (mp && typeof mp.pauseVideo === 'function') mp.pauseVideo();
      else v.pause();
    } catch (_) {
      try { v.pause(); } catch (__) {}
    }
    // Escalation, if something keeps resuming it: silence it outright.
    if (hard) { try { origMuted.set.call(v, true); } catch (_) {} }
  }

  function stopAllPreviews() {
    document.querySelectorAll(PREV_SEL + ' video').forEach(v => {
      if (v instanceof HTMLMediaElement && !v.paused) stopPreview(v, true);
    });
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAllPreviews(); });
  window.addEventListener('blur',     stopAllPreviews);
  window.addEventListener('pagehide', stopAllPreviews);

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

  // Polling backstop: re-enforces unmute + hard 1× for music previews.
  // Each element is handled in its own try/catch: on watch pages the
  // selector can match a <video> that is not a native media element (the
  // native getter throws "Illegal invocation"), and one bad element must
  // not abort the whole poll or flood the extension's error log.
  let pollWarned = false;
  setInterval(() => {
    const allowed = previewsAllowed();
    document.querySelectorAll(PREV_SEL + ' video').forEach(v => {
      if (!(v instanceof HTMLMediaElement)) return;
      try {
        const playing = !v.paused && !v.ended;
        // Re-evaluate music status each cycle (self-corrects if play fired
        // before the overlay was laid out) and lock music previews to 1×.
        if (playing) {
          v.__bennMusic = isMusicVideo(v);
          if (v.__bennMusic && v.playbackRate !== 1) v.playbackRate = 1;
        }
        // Stray playback: stop it, and never unmute it in the meantime.
        if (playing && !allowed) {
          if (!v.__bennStrayAt) v.__bennStrayAt = Date.now();
          if (Date.now() - v.__bennStrayAt >= STRAY_GRACE_MS) {
            v.__bennStops = (v.__bennStops || 0) + 1;
            // Retry a few times only. If YouTube keeps resuming it anyway,
            // the hard mute keeps it silent without hammering stopVideo()
            // eight times a second for as long as the page lives.
            if (v.__bennStops <= 5) stopPreview(v, v.__bennStops > 1);
            else if (!origMuted.get.call(v)) origMuted.set.call(v, true);
          }
          return;
        }
        v.__bennStrayAt = 0;
        if (playing) v.__bennStops = 0;
        if (userHasMuted) return;
        let flipped = false;
        if (origMuted.get.call(v)) { origMuted.set.call(v, false); flipped = true; }
        if (origVolume.get.call(v) < 0.01) origVolume.set.call(v, DEFAULT_VOLUME);
        if (flipped) syncMuteButton(v);
      } catch (err) {
        if (!pollWarned) {
          pollWarned = true;
          console.warn('[Benn YT Tools] preview poll: skipping element', v, err);
        }
      }
    });
  }, POLL_MS);

  // ── Default preview playback speed ───────────────────────────────────────
  document.addEventListener('play', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !inPrev(v)) return;
    v.__bennMusic = isMusicVideo(v);
    v.playbackRate = v.__bennMusic ? 1 : previewSpeed;
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
      // Music previews are locked at 1× — speed wheel is ignored entirely.
      if (isMusicVideo(v)) { v.playbackRate = 1; return; }
      const newRate = Math.max(0.1,
        Math.round((v.playbackRate + (up ? speedStep : -speedStep)) * 100) / 100);
      v.playbackRate = newRate;
      flash(newRate.toFixed(2) + '×', e.clientX, e.clientY);
      if (inPrev(v)) {
        previewSpeed = newRate;
        window.postMessage({ type: '__benn_yt_save__', previewSpeed: newRate }, '*');
      }
    }
  }

  document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('wheel',   onWheel, { passive: false, capture: true });

})();
