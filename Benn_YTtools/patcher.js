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
  let captionsOn   = false;   // remembered choice for the CC button below

  const origMuted   = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  const origVolume  = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const origSetAttr = Element.prototype.setAttribute;

  const PREV_SEL = 'ytd-video-preview,ytd-moving-thumbnail-renderer,yt-video-attribute-view-model,#video-preview';
  const CARD_SEL = 'ytd-rich-item-renderer,ytd-compact-video-renderer,ytd-video-renderer,ytd-grid-video-renderer';
  const LIKE_ID  = '__byt_like__';
  const CC_ID    = '__byt_cc__';
  const CTL_SEL  = '#' + LIKE_ID + ',#' + CC_ID;   // our own overlay controls

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
      const { scrubStep: s, speedStep: sp, previewSpeed: ps, captionsOn: cc } = e.data;
      if (typeof s  === 'number' && s  >= 1    && s  <= 15)  scrubStep    = s;
      if (typeof sp === 'number' && sp >= 0.05 && sp <= 0.5) speedStep    = sp;
      if (typeof ps === 'number' && ps >= 0.5  && ps <= 3)   previewSpeed = ps;
      if (typeof cc === 'boolean')                           captionsOn   = cc;
    }
  });

  // ── Card clicks ───────────────────────────────────────────────────────────
  // Sound on previews is unconditional now. Tracking "the user muted this"
  // was a losing game: YouTube has removed the mute toggle from the inline
  // preview controls, so a flag that got stuck on left every preview silent
  // with no way to switch it back. A preview is audible whenever it is
  // allowed to be (focused, visible, hovered) — nothing else.
  function pathHas(path, sel) {
    for (const el of path) {
      try { if (el.matches && el.matches(sel)) return true; } catch (_) {}
    }
    return false;
  }

  document.addEventListener('click', e => {
    const path = e.composedPath ? e.composedPath() : [];
    // Our own buttons live inside the thumbnail, so they are "in a card" too —
    // clicking them must not be mistaken for opening the video.
    if (pathHas(path, CTL_SEL)) return;
    if (!pathHas(path, CARD_SEL + ',' + PREV_SEL)) return;
    // Opening the video — no preview may outlive the click.
    setTimeout(stopAllPreviews, 0);
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
    // The like button floats over the thumbnail on document.body, so without
    // this the preview would be treated as stray while the pointer is on it.
    try {
      return !!(el.closest(PREV_SEL) || el.closest(CARD_SEL) || el.closest(CTL_SEL));
    } catch (_) { return false; }
  }

  // Focus deliberately plays no part: hovering a thumbnail in an unfocused
  // window should still play, with sound. What must hold is that the video
  // is really on screen under the pointer — and it is: document.hidden
  // covers a background tab, and Chrome/Brave also report a window that is
  // fully covered by another app as hidden (native occlusion tracking),
  // while the pointer being over the thumbnail means that spot is on top.
  function previewsAllowed() {
    return !document.hidden && pointerOverCard();
  }

  // Silence is element-level only: muting through the player API would be
  // saved by YouTube and handed to the watch page (the "starts muted" bug).
  function mutePreview(v) {
    try { if (!origMuted.get.call(v)) origMuted.set.call(v, true); } catch (_) {}
  }

  // Pause first and keep the frame. stopVideo() is YouTube's real teardown
  // but it unloads the video, which leaves a black tile reading -0:01 if the
  // preview is still on screen — so it is the last resort, not the default.
  function stopPreview(v, attempt) {
    const mp = playerOf(v);
    mutePreview(v);
    try {
      if (attempt >= 3 && mp && typeof mp.stopVideo === 'function') mp.stopVideo();
      else if (mp && typeof mp.pauseVideo === 'function')           mp.pauseVideo();
      else v.pause();
    } catch (_) {
      try { v.pause(); } catch (__) {}
    }
  }

  function stopAllPreviews() {
    document.querySelectorAll(PREV_SEL + ' video').forEach(v => {
      if (v instanceof HTMLMediaElement && !v.paused) stopPreview(v, 1);
    });
  }

  // A hidden tab cannot be hovered, so stopping is safe and invisible there.
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAllPreviews(); });
  window.addEventListener('pagehide', stopAllPreviews);
  // Nothing is done on window blur: alt-tabbing away while the pointer rests
  // on a thumbnail leaves the preview visible on screen, so it keeps playing
  // with sound. Moving the pointer off it, hiding the tab or covering the
  // window all still stop it through the rules above.

  // ── Audio patches ─────────────────────────────────────────────────────────
  Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
    get() { return origMuted.get.call(this); },
    set(val) {
      if (inPrev(this)) {
        if (val) {
          if (!previewsAllowed()) {
            // Window unfocused / tab hidden / pointer elsewhere: let YouTube's
            // mute stand. Unmuting here first and letting the poll re-mute a
            // moment later is what made unfocused hovers blurt out ~1s of
            // sound before going quiet.
            origMuted.set.call(this, true);
          } else {
            // YouTube auto-muting → block synchronously (never oscillate)
            const vid = this;
            origMuted.set.call(vid, false);
            if (origVolume.get.call(vid) < 0.01) origVolume.set.call(vid, DEFAULT_VOLUME);
            // Put YouTube's own player state back in sync afterwards
            setTimeout(() => syncMuteButton(vid), 0);
          }
        } else {
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
      if (val < 0.01 && inPrev(this) && previewsAllowed()) return;
      origVolume.set.call(this, val);
    }, configurable: true,
  });

  Element.prototype.setAttribute = function (n, v) {
    if (n === 'muted' && this instanceof HTMLVideoElement && inPrev(this) && previewsAllowed()) return;
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
        // Not allowed to be audible → silence it at once (no grace: this is
        // the sound the user should never hear), and stop it once it is clear
        // the preview is genuinely stray rather than still starting up.
        if (playing && !allowed) {
          mutePreview(v);
          if (!v.__bennStrayAt) v.__bennStrayAt = Date.now();
          // While the pointer is still on the card the preview is legitimate
          // (just unfocused) — keep it silent but leave it playing, exactly
          // as YouTube itself would.
          if (!pointerOverCard() && Date.now() - v.__bennStrayAt >= STRAY_GRACE_MS) {
            v.__bennStops = (v.__bennStops || 0) + 1;
            // Retry a few times only; muted already, so no need to hammer.
            if (v.__bennStops <= 5) stopPreview(v, v.__bennStops);
          }
          return;
        }
        v.__bennStrayAt = 0;
        if (playing) { v.__bennStops = 0; enforceCaptions(v); }
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

  // ── Like button on thumbnails ────────────────────────────────────────────
  // Likes the hovered video without opening it, by calling the same InnerTube
  // endpoint the watch page uses (/youtubei/v1/like/like). Requests from the
  // page need YouTube's SAPISIDHASH authorisation header — the cookies alone
  // give "You must be signed in to perform this operation".
  //
  // One shared button floating on document.body, positioned over whichever
  // card is hovered: a button injected into the card itself would be clipped
  // by the thumbnail's overflow:hidden. It sits top-LEFT because YouTube puts
  // its own hover controls top-right, the duration badge bottom-right, and
  // our seek bar along the bottom edge.
  //
  // Whether a video is ALREADY liked is not known — YouTube does not put that
  // in the home-page data and asking per card would be a request per
  // thumbnail — so the button starts neutral and tracks what you like here;
  // clicking a liked one again removes the like.

  const LIKE_COLOR = '#3ea6ff';   // YouTube's own accent blue
  const liked   = new Set();      // videoIds liked during this page session
  let likeBtn   = null;
  let ccBtn     = null;
  let likeCard  = null;           // card the button is currently attached to
  let likeBusy  = false;

  function loggedIn() {
    try { return !!(window.ytcfg && ytcfg.get('LOGGED_IN')); } catch (_) { return false; }
  }

  function videoIdOf(card) {
    try {
      const a = card.querySelector('a#thumbnail[href], a[href*="/watch?v="]');
      if (!a) return null;
      return new URL(a.href, location.origin).searchParams.get('v');
    } catch (_) { return null; }
  }

  // Authorization: SAPISIDHASH <ts>_<sha1(ts + " " + SAPISID + " " + origin)>
  async function sapisidHash() {
    const m = document.cookie.match(
      /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID|__Secure-1PAPISID)=([^;]+)/);
    if (!m || !crypto.subtle) return null;
    const ts   = Math.floor(Date.now() / 1000);
    const data = ts + ' ' + decodeURIComponent(m[1]) + ' ' + location.origin;
    const buf  = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(data));
    const hex  = Array.from(new Uint8Array(buf))
                      .map(b => b.toString(16).padStart(2, '0')).join('');
    return 'SAPISIDHASH ' + ts + '_' + hex;
  }

  // NOTE: asking YouTube whether a video is already liked does not work.
  // /youtubei/v1/next answers INDIFFERENT for videos that are demonstrably in
  // the account's Liked list — tested against that list in the signed-in
  // browser, with every auth variant (SAPISIDHASH / SAPISID1PHASH /
  // SAPISID3PHASH, with and without the api key, with watch-page context);
  // a browse of the Liked playlist came back generic too. YouTube simply
  // does not hand personalised like state to these calls, so the button
  // starts neutral and only reflects likes made through it in this session.
  async function innertube(path, body) {
    const key     = ytcfg.get('INNERTUBE_API_KEY');
    const context = ytcfg.get('INNERTUBE_CONTEXT');
    if (!key || !context) throw new Error('no InnerTube config');
    const headers = {
      'Content-Type':    'application/json',
      'X-Origin':        location.origin,
      'X-Goog-AuthUser': String(ytcfg.get('SESSION_INDEX') || 0),
    };
    const auth = await sapisidHash();
    if (auth) headers['Authorization'] = auth;
    const pageId = ytcfg.get('DELEGATED_SESSION_ID');
    if (pageId) headers['X-Goog-PageId'] = pageId;
    const res = await fetch('/youtubei/v1/' + path +
                            '?key=' + encodeURIComponent(key) + '&prettyPrint=false',
      { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify(Object.assign({ context }, body)) });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
    return res;
  }

  async function sendLike(videoId, remove) {
    return innertube('like/' + (remove ? 'removelike' : 'like'), { target: { videoId } });
  }

  function thumbIcon(on) {
    // Built with DOM calls, not innerHTML: youtube.com enforces Trusted Types.
    const NS  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.style.pointerEvents = 'none';
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M18.77,11h-4.23l1.52-4.94C16.38,5.03,15.54,4,14.38,4c-0.58,0-1.14,0.24-1.52,0.65' +
                           'L7,11H3v10h4h1h9.43c1.06,0,1.98-0.67,2.19-1.61l1.34-6C21.23,12.15,20.18,11,18.77,11z');
    path.setAttribute('fill', on ? LIKE_COLOR : '#fff');
    svg.appendChild(path);
    return svg;
  }

  function setLikeIcon(on) {
    if (!likeBtn) return;
    while (likeBtn.firstChild) likeBtn.removeChild(likeBtn.firstChild);
    likeBtn.appendChild(thumbIcon(on));
    likeBtn.style.background = on ? 'rgba(62,166,255,0.18)' : 'rgba(0,0,0,0.65)';
    likeBtn.style.outline    = on ? '1px solid ' + LIKE_COLOR : '1px solid rgba(255,255,255,0.25)';
  }

  // Moving the pointer onto the button used to end the preview: the button
  // sat on document.body, so leaving the thumbnail for it fired mouseout /
  // mouseleave on the card and YouTube ran its teardown. Two defences —
  // mount the button INSIDE the hovered thumbnail (measured: the thumbnail
  // chain is overflow:visible, so nothing is clipped, and z-index keeps it on
  // top), and swallow the leave events whose relatedTarget is the button, for
  // the layouts where YouTube listens on an inner element.
  for (const type of ['mouseout', 'mouseleave', 'pointerout', 'pointerleave']) {
    document.addEventListener(type, e => {
      const to = e.relatedTarget;
      if (to && to.closest && to.closest(CTL_SEL)) e.stopPropagation();
    }, true);
  }

  function ensureLikeBtn() {
    if (likeBtn) return likeBtn;
    if (!document.body) return null;
    likeBtn = document.createElement('div');
    likeBtn.id = LIKE_ID;
    likeBtn.setAttribute('role', 'button');
    likeBtn.setAttribute('title', 'Like this video (Benn YT Tools)');
    likeBtn.setAttribute('style',
      'position:fixed;z-index:2147483647;display:none;align-items:center;justify-content:center;' +
      'width:30px;height:30px;border-radius:50%;cursor:pointer;' +
      'background:rgba(0,0,0,0.65);outline:1px solid rgba(255,255,255,0.25);' +
      'transition:transform 0.1s,background 0.1s');
    likeBtn.addEventListener('mouseenter', () => { likeBtn.style.transform = 'scale(1.12)'; });
    likeBtn.addEventListener('mouseleave', () => { likeBtn.style.transform = 'none'; });
    // Capture phase + preventDefault: never let the click reach the card link.
    likeBtn.addEventListener('click', onLikeClick, true);
    likeBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); }, true);
    setLikeIcon(false);
    document.body.appendChild(likeBtn);
    return likeBtn;
  }

  async function onLikeClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (likeBusy || !likeCard) return;
    const id = videoIdOf(likeCard);
    if (!id) { flash('No video id'); return; }

    const remove = liked.has(id);
    likeBusy = true;
    likeBtn.style.opacity = '0.5';
    const r = likeBtn.getBoundingClientRect();
    try {
      await sendLike(id, remove);
      if (remove) liked.delete(id); else liked.add(id);
      setLikeIcon(!remove);
      flash(remove ? 'Like removed' : 'Liked', r.left + r.width / 2, r.top - 18);
    } catch (err) {
      setLikeIcon(false);
      flash('Like failed', r.left + r.width / 2, r.top - 18);
      console.warn('[Benn YT Tools] like failed:', err);
    }
    likeBtn.style.opacity = '1';
    likeBusy = false;
  }

  function positionLikeBtn(card) {
    const btn = ensureLikeBtn();
    if (!btn) return;
    const thumb = card.querySelector('ytd-thumbnail, yt-thumbnail-view-model, a#thumbnail') || card;
    const r = thumb.getBoundingClientRect();
    if (!r.width || !r.height) { btn.style.display = 'none'; return; }

    // Host them in the thumbnail (so the pointer never leaves the card as far
    // as YouTube is concerned), positioned relative to that host.
    const host = thumb;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const hr = host.getBoundingClientRect();
    const top  = r.top  - hr.top  + 8;
    const left = r.left - hr.left + 8;

    if (btn.parentElement !== host) host.appendChild(btn);
    btn.style.position = 'absolute';
    btn.style.top      = top + 'px';
    btn.style.left     = left + 'px';
    btn.style.display  = 'flex';

    const cc = ensureCcBtn();
    if (cc) {
      if (cc.parentElement !== host) host.appendChild(cc);
      setCcIcon(captionsOn);
      cc.style.position = 'absolute';
      cc.style.top      = top + 'px';
      cc.style.left     = (left + 36) + 'px';
      cc.style.display  = 'flex';
    }

    // If a layout does clip it after all, fall back to floating on the body.
    const br = btn.getBoundingClientRect();
    let topEl = null;
    try { topEl = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); } catch (_) {}
    if (topEl && !btn.contains(topEl) && topEl !== btn) {
      document.body.appendChild(btn);
      btn.style.position = 'fixed';
      btn.style.top      = (r.top + 8) + 'px';
      btn.style.left     = (r.left + 8) + 'px';
      if (cc) {
        document.body.appendChild(cc);
        cc.style.position = 'fixed';
        cc.style.top      = (r.top + 8) + 'px';
        cc.style.left     = (r.left + 44) + 'px';
      }
    }
  }

  function hideLikeBtn() {
    if (likeBtn) likeBtn.style.display = 'none';
    if (ccBtn)   ccBtn.style.display   = 'none';
    likeCard = null;
  }

  function cardFromEvent(e) {
    const path = e.composedPath ? e.composedPath() : [];
    for (const el of path) {
      try { if (el.matches && el.matches(CARD_SEL)) return el; } catch (_) {}
    }
    return null;
  }

  document.addEventListener('mouseover', e => {
    if (!loggedIn()) return;
    const card = cardFromEvent(e);
    if (!card) return;
    if (card !== likeCard) {
      likeCard = card;
      const id = videoIdOf(card);
      setLikeIcon(!!id && liked.has(id));
    }
    positionLikeBtn(card);
  }, true);

  // Keep it glued to the card while scrolling, and take it away once the
  // pointer is neither on the card nor on the button itself.
  // ── Captions toggle on thumbnails ────────────────────────────────────────
  // YouTube emptied the inline preview controls (the container is still
  // rendered, but with no mute and no CC button in it), so previews lost
  // captions entirely. The player API is untouched though — verified on the
  // live player: loadModule('captions'), toggleSubtitles(), isSubtitlesOn()
  // and getOption/setOption('captions', …) all still work. So we drive it
  // ourselves, and remember the choice for every later preview.

  function captionsAreOn(mp) {
    try { return !!(mp && mp.isSubtitlesOn && mp.isSubtitlesOn()); } catch (_) { return false; }
  }

  // Turning captions ON also flips YouTube's own "subtitles" preference, so
  // every later preview comes back with captions whatever our button says.
  // OFF therefore has to be enforced too — clearing the track is YouTube's
  // documented way of switching them off — and the poll re-applies the
  // chosen state to each preview, which is what makes the button a toggle
  // rather than a one-way switch.
  // Only load the module when it is not already there: calling loadModule on
  // a player that has captions loaded resets them (measured — it switched a
  // live caption track back off), which would fight our own enforcement.
  function captionsModuleReady(mp) {
    try {
      const o = mp.getOptions && mp.getOptions();
      return !!(o && o.indexOf('captions') !== -1);
    } catch (_) { return false; }
  }

  function applyCaptions(mp, on) {
    if (!mp) return;
    try {
      if (on) {
        if (!captionsModuleReady(mp) && mp.loadModule) mp.loadModule('captions');
        if (!captionsAreOn(mp)) {
          if (mp.toggleSubtitlesOn)   mp.toggleSubtitlesOn();
          else if (mp.toggleSubtitles) mp.toggleSubtitles();
        }
      } else {
        if (mp.setOption) mp.setOption('captions', 'track', {});
        if (captionsAreOn(mp) && mp.toggleSubtitles) mp.toggleSubtitles();
      }
    } catch (_) {}
  }

  // Keep every playing preview on the chosen setting (throttled per player).
  function enforceCaptions(v) {
    const mp = playerOf(v);
    if (!mp || !mp.isSubtitlesOn) return;
    if (captionsAreOn(mp) === captionsOn) { v.__bennCcAt = 0; return; }
    const now = Date.now();
    if (v.__bennCcAt && now - v.__bennCcAt < 700) return;
    v.__bennCcAt = now;
    applyCaptions(mp, captionsOn);
  }

  function setCcIcon(on) {
    if (!ccBtn) return;
    ccBtn.style.color      = on ? '#000' : '#fff';
    ccBtn.style.background = on ? LIKE_COLOR : 'rgba(0,0,0,0.65)';
    ccBtn.style.outline    = '1px solid ' + (on ? LIKE_COLOR : 'rgba(255,255,255,0.25)');
  }

  function onCcClick(e) {
    e.preventDefault();
    e.stopPropagation();
    captionsOn = !captionsOn;
    setCcIcon(captionsOn);
    // Apply to every preview player present, not just the active one, so a
    // second preview cannot come back with the old setting.
    document.querySelectorAll(PREV_SEL + ' .html5-video-player').forEach(mp => {
      applyCaptions(mp, captionsOn);
      if (mp.querySelector) { const v = mp.querySelector('video'); if (v) v.__bennCcAt = 0; }
    });
    // Captions can take a moment to attach after the module loads.
    setTimeout(() => applyCaptions(previewPlayer(), captionsOn), 600);
    window.postMessage({ type: '__benn_yt_save__', captionsOn }, '*');
    const r = ccBtn.getBoundingClientRect();
    flash(captionsOn ? 'Captions on' : 'Captions off', r.left + r.width / 2, r.top - 18);
  }

  function ensureCcBtn() {
    if (ccBtn) return ccBtn;
    if (!document.body) return null;
    ccBtn = document.createElement('div');
    ccBtn.id = CC_ID;
    ccBtn.setAttribute('role', 'button');
    ccBtn.setAttribute('title', 'Subtitles/CC on previews (Benn YT Tools)');
    ccBtn.textContent = 'CC';
    ccBtn.setAttribute('style',
      'position:absolute;z-index:2147483647;display:none;align-items:center;justify-content:center;' +
      'width:30px;height:30px;border-radius:50%;cursor:pointer;' +
      'font:700 11px Roboto,Arial,sans-serif;letter-spacing:0.5px;' +
      'background:rgba(0,0,0,0.65);outline:1px solid rgba(255,255,255,0.25);' +
      'transition:transform 0.1s,background 0.1s');
    ccBtn.addEventListener('mouseenter', () => { ccBtn.style.transform = 'scale(1.12)'; });
    ccBtn.addEventListener('mouseleave', () => { ccBtn.style.transform = 'none'; });
    ccBtn.addEventListener('click', onCcClick, true);
    ccBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); }, true);
    setCcIcon(captionsOn);
    document.body.appendChild(ccBtn);
    return ccBtn;
  }

  // Every preview that starts inherits the remembered choice, in both
  // directions (the poll keeps it there if YouTube changes its mind later).
  document.addEventListener('play', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !inPrev(v)) return;
    const mp = playerOf(v);
    applyCaptions(mp, captionsOn);
    setTimeout(() => applyCaptions(mp, captionsOn), 600);
  }, true);

  setInterval(() => {
    if (!likeCard || !likeBtn || likeBtn.style.display === 'none') return;
    if (!likeCard.isConnected) { hideLikeBtn(); return; }
    let over = false;
    if (ptrX >= 0) {
      try {
        const el = document.elementFromPoint(ptrX, ptrY);
        over = !!(el && el.closest &&
                 (el.closest(CTL_SEL) || (likeCard.contains(el) || el.closest(PREV_SEL))));
      } catch (_) {}
    }
    if (over) positionLikeBtn(likeCard); else hideLikeBtn();
  }, POLL_MS);

})();
