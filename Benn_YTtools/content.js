(() => {
  'use strict';

  const DEFAULTS = {
    playedColor:   '#afafaf',
    playedAlpha:   1,
    unplayedColor: '#4b4b4b',
    unplayedAlpha: 1,
    textColor:     '#afafaf',
    textAlpha:     1,
    fontSize:      8,
    scrubStep:     5,
    speedStep:     0.2,
    previewSpeed:  1.5,
  };

  const BAR_ID   = '__byt_bar__';
  const TIME_ID  = '__byt_time__';
  const STYLE_ID = '__byt_style__';
  const GAP_PX   = 2;

  let cfg = { ...DEFAULTS };

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      `#${TIME_ID}{` +
        `-webkit-font-smoothing:none;` +
        `font-smooth:never;` +
        `text-rendering:optimizeSpeed` +
      `}`;
    (document.head || document.documentElement).appendChild(s);
  }

  function ensureBar(player) {
    let wrap = player.querySelector(':scope > #' + BAR_ID);
    if (!wrap) {
      if (getComputedStyle(player).position === 'static')
        player.style.position = 'relative';

      wrap = document.createElement('div');
      wrap.id = BAR_ID;
      Object.assign(wrap.style, {
        position:      'absolute',
        left:          '0',
        bottom:        '0',
        width:         '100%',
        height:        '1px',
        pointerEvents: 'none',
        zIndex:        '2147483647',
        display:       'block',
      });

      const played = document.createElement('div');
      Object.assign(played.style, {
        position: 'absolute',
        left:     '0',
        top:      '0',
        height:   '100%',
        width:    '0%',
      });
      wrap.appendChild(played);
      wrap._played = played;
      player.appendChild(wrap);
    }

    wrap.style.background         = rgba(cfg.unplayedColor, cfg.unplayedAlpha);
    wrap._played.style.background = rgba(cfg.playedColor,   cfg.playedAlpha);
    return wrap;
  }

  function ensureTime(player) {
    let el = player.querySelector(':scope > #' + TIME_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TIME_ID;
      Object.assign(el.style, {
        position:           'absolute',
        left:               '0',
        bottom:             (1 + GAP_PX) + 'px',
        fontFamily:         '"Courier New", Courier, monospace',
        fontWeight:         'normal',
        fontStyle:          'normal',
        fontVariantNumeric: 'tabular-nums',
        padding:            '0 2px',
        pointerEvents:      'none',
        zIndex:             '2147483647',
        whiteSpace:         'nowrap',
        userSelect:         'none',
        letterSpacing:      '0',
      });
      player.appendChild(el);
    }
    el.style.fontSize   = cfg.fontSize + 'px';
    el.style.lineHeight = cfg.fontSize + 'px';
    el.style.color      = rgba(cfg.textColor, cfg.textAlpha);
    return el;
  }

  function fmt(secs) {
    const s  = secs | 0;
    const h  = (s / 3600) | 0;
    const m  = ((s % 3600) / 60) | 0;
    const S  = s % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(S).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ── Hover-preview seek bar ────────────────────────────────────────────────
  // Since ~2026-09-21 (client 2.20260921) YouTube builds the inline hover-
  // preview player with controlsType=0, so the old ytp progress bar is gone
  // (#inline-preview-player gets ytp-hide-controls, no .ytp-chrome-bottom).
  // Its replacement is a web component, <yt-inline-player-controls> holding a
  // <yt-progress-bar>, mounted in ytd-video-preview #player-controls — which
  // YouTube hides with `ytd-video-preview[hide-player-controls]` (preview.css
  // overrides that). Some sessions still get no bar at all, so:
  //   • if YouTube's <yt-progress-bar> is actually rendered → do nothing;
  //   • otherwise draw our own bar inside #inline-preview-player
  //     (position:relative, overflow:hidden — same as #movie_player) and seek
  //     on click/drag.
  // Never overlay ours on the native one: #inline-preview-player is a
  // stacking context (z-index:0), so ours would sit UNDER the native slider,
  // which would grab pointerdown while we swallow pointerup → YouTube's
  // scrubber gets stuck and pauses the preview.
  //
  // The player sits inside <a id="media-container-link">, so every pointer
  // event on our bar is swallowed at window-capture level (fires before every
  // YouTube listener, and before patcher.js's document-level click tracker),
  // otherwise a click navigates to the watch page.
  const PBAR_ID    = '__byt_pbar__';
  const PBAR_H     = 3;    // idle bar height (px)
  const PBAR_H_HOT = 5;    // while hovered / dragging
  const PBAR_HIT   = 14;   // invisible grab area above the bar
  const PREV_PLAYER_SEL = 'ytd-video-preview .html5-video-player';

  let pbarDrag = null;    // { hit, video } while the user is dragging
  let pbarHot  = false;   // pointer currently over the grab area

  function previewPlayer() {
    return document.getElementById('inline-preview-player') ||
           document.querySelector(PREV_PLAYER_SEL);
  }

  // True when YouTube's own <yt-progress-bar> is present AND actually painted
  // (not display:none / visibility:hidden / opacity:0 anywhere up the tree).
  function nativePreviewBarVisible(player) {
    const prev = player.closest('ytd-video-preview') || player.parentElement;
    const bar  = prev && prev.querySelector('yt-progress-bar');
    if (!bar) return false;
    if (bar.checkVisibility && !bar.checkVisibility({
          opacityProperty: true, visibilityProperty: true,   // Chrome ≥ 121
          checkOpacity:    true, checkVisibilityCSS: true,   // Chrome 105–120
        })) return false;
    return bar.getBoundingClientRect().height > 0;
  }

  function ensurePreviewBar(player) {
    let hit = player.querySelector(':scope > #' + PBAR_ID);
    if (!hit) {
      if (getComputedStyle(player).position === 'static')
        player.style.position = 'relative';

      hit = document.createElement('div');
      hit.id = PBAR_ID;
      Object.assign(hit.style, {
        position:      'absolute',
        left:          '0',
        bottom:        '0',
        width:         '100%',
        height:        PBAR_HIT + 'px',
        zIndex:        '2147483647',
        cursor:        'pointer',
        pointerEvents: 'auto',
        touchAction:   'none',
      });

      const bar = document.createElement('div');
      Object.assign(bar.style, {
        position:   'absolute',
        left:       '0',
        bottom:     '0',
        width:      '100%',
        height:     PBAR_H + 'px',
        transition: 'height 0.1s',
      });

      const played = document.createElement('div');
      Object.assign(played.style, {
        position: 'absolute',
        left:     '0',
        top:      '0',
        height:   '100%',
        width:    '0%',
      });

      const tip = document.createElement('div');
      Object.assign(tip.style, {
        position:      'absolute',
        left:          '0',
        bottom:        (PBAR_HIT + 2) + 'px',
        transform:     'translateX(-50%)',
        display:       'none',
        background:    'rgba(0,0,0,0.75)',
        padding:       '1px 4px',
        borderRadius:  '3px',
        fontFamily:    '"Courier New", Courier, monospace',
        fontSize:      '11px',
        lineHeight:    '14px',
        whiteSpace:    'nowrap',
        pointerEvents: 'none',
        userSelect:    'none',
      });

      bar.appendChild(played);
      hit.appendChild(bar);
      hit.appendChild(tip);
      hit._bar    = bar;
      hit._played = played;
      hit._tip    = tip;
      player.appendChild(hit);
    }

    hit._bar.style.background    = rgba(cfg.unplayedColor, cfg.unplayedAlpha);
    hit._played.style.background = rgba(cfg.playedColor,   cfg.playedAlpha);
    hit._tip.style.color         = rgba(cfg.textColor,     cfg.textAlpha);
    hit._bar.style.height        = (pbarHot || pbarDrag ? PBAR_H_HOT : PBAR_H) + 'px';
    return hit;
  }

  function pbarFromEvent(e) {
    const path = e.composedPath ? e.composedPath() : [];
    for (const el of path) if (el && el.id === PBAR_ID) return el;
    return null;
  }

  function pbarVideo(hit) {
    const v = hit.parentElement && hit.parentElement.querySelector('video');
    return v && v.duration > 0 && isFinite(v.duration) ? v : null;
  }

  function pbarFraction(hit, e) {
    const r = hit.getBoundingClientRect();
    return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  }

  function pbarShowTip(hit, video, frac) {
    const tip = hit._tip;
    tip.textContent   = fmt(frac * video.duration);
    tip.style.display = 'block';
    const w = hit.clientWidth, tw = tip.offsetWidth;
    tip.style.left = Math.max(tw / 2, Math.min(w - tw / 2, frac * w)) + 'px';
  }

  function pbarHideTip() {
    const hit = document.getElementById(PBAR_ID);
    if (hit && hit._tip) hit._tip.style.display = 'none';
  }

  function pbarSeek(hit, video, e) {
    const f = pbarFraction(hit, e);
    video.currentTime = f * video.duration;
    hit._played.style.width = (f * 100) + '%';
    pbarShowTip(hit, video, f);
  }

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onPbarPointerDown(e) {
    const hit = pbarFromEvent(e);
    if (!hit || e.button !== 0) return;
    const video = pbarVideo(hit);
    if (!video) return;
    swallow(e);
    pbarDrag = { hit, video };
    try { hit.setPointerCapture(e.pointerId); } catch (_) {}
    pbarSeek(hit, video, e);
  }

  function onPbarPointerMove(e) {
    if (pbarDrag) { pbarSeek(pbarDrag.hit, pbarDrag.video, e); return; }
    const hit = pbarFromEvent(e);
    if (hit) {
      pbarHot = true;
      const video = pbarVideo(hit);
      if (video) pbarShowTip(hit, video, pbarFraction(hit, e));
    } else if (pbarHot) {
      pbarHot = false;
      pbarHideTip();
    }
  }

  function onPbarPointerUp(e) {
    if (!pbarDrag) return;
    const { hit, video } = pbarDrag;
    swallow(e);
    pbarSeek(hit, video, e);
    try { hit.releasePointerCapture(e.pointerId); } catch (_) {}
    pbarDrag = null;
    if (!pbarFromEvent(e)) { pbarHot = false; pbarHideTip(); }
  }

  function onPbarPointerCancel(e) {
    if (!pbarDrag) return;
    try { pbarDrag.hit.releasePointerCapture(e.pointerId); } catch (_) {}
    pbarDrag = null;
    pbarHot  = false;
    pbarHideTip();
  }

  // Window-capture: runs before any document/element listener on the page.
  window.addEventListener('pointerdown',   onPbarPointerDown,   true);
  window.addEventListener('pointermove',   onPbarPointerMove,   true);
  window.addEventListener('pointerup',     onPbarPointerUp,     true);
  window.addEventListener('pointercancel', onPbarPointerCancel, true);
  // Compat mouse/touch events would still reach the <a> and navigate — kill them.
  for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'touchstart', 'touchend'])
    window.addEventListener(t, e => { if (pbarFromEvent(e)) swallow(e); },
      { capture: true, passive: false });

  function tick() {
    const player = document.getElementById('movie_player');
    const video  = player && player.querySelector('video');
    if (player && video && video.duration > 0 && isFinite(video.duration)) {
      const bar = ensureBar(player);
      bar._played.style.width = (video.currentTime / video.duration * 100) + '%';
      const pct = Math.round(video.currentTime / video.duration * 100);
      ensureTime(player).textContent = fmt(video.currentTime) + ' - ' + pct + '%';
    }

    const pp = previewPlayer();
    const pv = pp && pp.querySelector('video');
    if (pp && pv && pv.duration > 0 && isFinite(pv.duration)) {
      if (nativePreviewBarVisible(pp)) {
        const hit = pp.querySelector(':scope > #' + PBAR_ID);
        if (hit) hit.style.display = 'none';
      } else {
        const hit = ensurePreviewBar(pp);
        hit.style.display = 'block';
        // While dragging, pbarSeek() already paints the target position; don't
        // let a not-yet-seeked currentTime snap the bar back for a frame.
        if (!pbarDrag) hit._played.style.width = (pv.currentTime / pv.duration * 100) + '%';
      }
    }
    requestAnimationFrame(tick);
  }

  // Bridge: relay hover settings to MAIN-world patcher via postMessage.
  // e.source === window check in patcher prevents any third-party spoofing.
  function postHoverSettings() {
    window.postMessage({
      type:         '__benn_yt_settings__',
      scrubStep:    cfg.scrubStep,
      speedStep:    cfg.speedStep,
      previewSpeed: cfg.previewSpeed,
    }, '*');
  }

  // Receive save requests from patcher (MAIN world) and persist to local storage.
  window.addEventListener('message', e => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== '__benn_yt_save__') return;
    const { previewSpeed: ps } = e.data;
    if (typeof ps === 'number' && ps >= 0.5 && ps <= 3) {
      chrome.storage.local.set({ previewSpeed: ps });
    }
  });

  function startWithCfg(stored) {
    Object.assign(cfg, stored);
    postHoverSettings();
    tick();
  }

  // Storage = chrome.storage.local (NO per-minute write quota, unlike sync —
  // sync's 120 writes/min limit was silently breaking live colour updates
  // after a few seconds of slider dragging). One-time migration copies any
  // previously-saved sync values into local so tuned colours carry over.
  chrome.storage.local.get('__byt_migrated', res => {
    if (res.__byt_migrated) {
      chrome.storage.local.get(DEFAULTS, startWithCfg);
    } else {
      chrome.storage.sync.get(DEFAULTS, syncVals => {
        chrome.storage.local.set({ ...syncVals, __byt_migrated: true }, () => {
          chrome.storage.local.get(DEFAULTS, startWithCfg);
        });
      });
    }
  });

  injectStyle();

  // Primary path: instant update when popup writes to local storage.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, { newValue }] of Object.entries(changes))
      if (k in DEFAULTS) cfg[k] = newValue;
    postHoverSettings();
  });

  // Backup poll (≥10 fps): re-reads local + re-posts hover settings to the
  // MAIN-world patcher. Local reads are unlimited, so this can never break.
  setInterval(() => {
    chrome.storage.local.get(DEFAULTS, stored => {
      Object.assign(cfg, stored);
      postHoverSettings();
    });
  }, 100);

})();
