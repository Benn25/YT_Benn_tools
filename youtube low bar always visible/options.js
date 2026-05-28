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

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function $(id) { return document.getElementById(id); }

  function readForm() {
    return {
      playedColor:   $('playedColor').value,
      playedAlpha:   parseFloat($('playedAlpha').value),
      unplayedColor: $('unplayedColor').value,
      unplayedAlpha: parseFloat($('unplayedAlpha').value),
      textColor:     $('textColor').value,
      textAlpha:     parseFloat($('textAlpha').value),
    };
  }

  function applyForm(cfg) {
    $('playedColor').value   = cfg.playedColor;
    $('playedAlpha').value   = cfg.playedAlpha;
    $('unplayedColor').value = cfg.unplayedColor;
    $('unplayedAlpha').value = cfg.unplayedAlpha;
    $('textColor').value     = cfg.textColor;
    $('textAlpha').value     = cfg.textAlpha;
    updatePreview();
  }

  function updatePreview() {
    const cfg = readForm();
    $('prevPlayed').style.background   = rgba(cfg.playedColor,   cfg.playedAlpha);
    $('prevUnplayed').style.background = rgba(cfg.unplayedColor, cfg.unplayedAlpha);
    $('prevTime').style.color          = rgba(cfg.textColor,     cfg.textAlpha);
    $('playedAlphaVal').textContent    = cfg.playedAlpha.toFixed(2);
    $('unplayedAlphaVal').textContent  = cfg.unplayedAlpha.toFixed(2);
    $('textAlphaVal').textContent      = cfg.textAlpha.toFixed(2);
  }

  function showStatus(msg) {
    $('status').textContent = msg;
    setTimeout(() => { $('status').textContent = ''; }, 2000);
  }

  // Live preview on any input change
  ['playedColor', 'playedAlpha', 'unplayedColor', 'unplayedAlpha', 'textColor', 'textAlpha']
    .forEach(id => $(id).addEventListener('input', updatePreview));

  $('saveBtn').addEventListener('click', () => {
    chrome.storage.sync.set(readForm(), () => showStatus('Saved.'));
  });

  $('resetBtn').addEventListener('click', () => {
    chrome.storage.sync.set(DEFAULTS, () => {
      applyForm(DEFAULTS);
      showStatus('Reset to defaults.');
    });
  });

  // Load stored settings on open
  chrome.storage.sync.get(DEFAULTS, stored => applyForm({ ...DEFAULTS, ...stored }));
})();
