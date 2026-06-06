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

  function tick() {
    const player = document.getElementById('movie_player');
    const video  = player && player.querySelector('video');
    if (player && video && video.duration > 0 && isFinite(video.duration)) {
      const bar = ensureBar(player);
      bar._played.style.width = (video.currentTime / video.duration * 100) + '%';
      const pct = Math.round(video.currentTime / video.duration * 100);
      ensureTime(player).textContent = fmt(video.currentTime) + ' - ' + pct + '%';
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
