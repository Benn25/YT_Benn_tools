(() => {
  'use strict';

  const COLOR_PLAYED   = 'rgb(175,175,175)';
  const COLOR_UNPLAYED = 'rgb(75,75,75)';
  const BAR_ID         = '__yt_pixel_progress__';

  let rafId = null;

  function ensureBar(player) {
    let wrap = player.querySelector(':scope > #' + BAR_ID);
    if (wrap) return wrap;

    // Make sure the player is a positioning context (it normally is).
    if (getComputedStyle(player).position === 'static') {
      player.style.position = 'relative';
    }

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
      background:    COLOR_UNPLAYED, // unplayed shows through
      display:       'block',
    });

    const played = document.createElement('div');
    Object.assign(played.style, {
      position:   'absolute',
      left:       '0',
      top:        '0',
      height:     '100%',
      width:      '0%',
      background: COLOR_PLAYED,
    });
    wrap.appendChild(played);
    wrap._played = played;

    player.appendChild(wrap);
    return wrap;
  }

  function tick() {
    const player = document.getElementById('movie_player');
    const video  = player && player.querySelector('video');

    if (player && video && video.duration > 0) {
      const wrap = ensureBar(player);
      const pct  = (video.currentTime / video.duration) * 100;
      wrap._played.style.width = pct + '%';
    }
    rafId = requestAnimationFrame(tick);
  }

  if (rafId === null) tick();
})();
