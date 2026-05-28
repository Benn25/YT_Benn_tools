(() => {
  'use strict';

  const DEFAULTS = {
    playedColor:   '#afafaf',
    playedAlpha:   1,
    unplayedColor: '#4b4b4b',
    unplayedAlpha: 1,
    textColor:     '#afafaf',
    textAlpha:     1,
  };

  const BAR_ID   = '__yt_ppb_bar__';
  const TIME_ID  = '__yt_ppb_time__';
  const STYLE_ID = '__yt_ppb_style__';
  const FONT_PX  = 10;
  const GAP_PX   = 2; // gap between text bottom and bar top

  let cfg = { ...DEFAULTS };

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    // Force pixel-crisp rendering on our time element
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

    wrap.style.background          = rgba(cfg.unplayedColor, cfg.unplayedAlpha);
    wrap._played.style.background  = rgba(cfg.playedColor,   cfg.playedAlpha);
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
        bottom:             (1 + GAP_PX) + 'px', // 1px bar + gap
        fontFamily:         '"Courier New", Courier, monospace',
        fontSize:           FONT_PX + 'px',
        lineHeight:         FONT_PX + 'px',
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
    el.style.color = rgba(cfg.textColor, cfg.textAlpha);
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
      ensureTime(player).textContent = fmt(video.currentTime);
    }

    requestAnimationFrame(tick);
  }

  injectStyle();

  chrome.storage.sync.get(DEFAULTS, stored => {
    Object.assign(cfg, stored);
    tick();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes))
      if (k in DEFAULTS) cfg[k] = newValue;
  });
})();
