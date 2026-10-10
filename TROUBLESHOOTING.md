# Problem log

Every real problem hit while building Benn YT Tools: what it looked like, what
actually caused it (and how that was established), what fixed it, and what to
remember. Newest first. Version numbers match `manifest.json` and the git
history.

Read this before debugging: most "bugs" here turned out to be YouTube changing
underneath us or two extensions disagreeing, not our code.

- [YouTube changes timeline](#youtube-changes-timeline)
- [Conflicts with other extensions](#conflicts-with-other-extensions)
- [Problems and fixes](#problems-and-fixes)
- [Dead ends](#dead-ends)
- [How to debug this extension](#how-to-debug-this-extension)

---

## YouTube changes timeline

| When | What YouTube changed | Effect on us | Handled in |
| --- | --- | --- | --- |
| ~2026-10-08 | Started rendering its own progress bar (`yt-progress-bar` in `#player-controls`) inside hover previews again, and shows those controls itself while a preview plays (`hide-player-controls` is removed during playback) | Gave SponsorBlock a YouTube-owned element to inject into → see the watcher conflict below. Also made the preview bar clickable YouTube UI, which our click rule mistook for "opening the video" | v1.4.2, v1.5.0 |
| ~2026-10 (present by 10-09) | While a preview plays, the preview loader watches the page with a `MutationObserver` (`childList`, `subtree`) and **deactivates** the preview on DOM changes (`deactivate → stopPlayer → cancelPlayback`) | Any extension that edits the DOM near a playing preview can kill it | v1.5.0 |
| ~2026-10 | Newer card element `yt-lockup-view-model` (Liked videos playlist and other surfaces) | Not recognised as a card → previews on it treated as stray, no buttons | v1.4.3 |
| 2026-09-27 | Emptied the inline preview controls: `yt-inline-player-controls` still renders but with **no mute and no CC button** (both existed on 09-22). Player API untouched | Lost captions and mute on previews | v1.3.0 (own CC button), v1.2.1 (sound always on) |
| 2026-09-21 (client 2.20260921) | Rebuilt the inline hover-preview player with `controlsType = 0`: the old `.ytp-progress-bar` is never rendered; replacement `yt-inline-player-controls` / `yt-progress-bar` hidden by `ytd-video-preview[hide-player-controls]`, rendered or not depending on the account | Draggable preview progress bar disappeared | v1.1.0 |

Long-standing YouTube behaviour that shaped the design (not changes, but traps):

- A preview is torn down **only on pointer `mouseleave`** of the card. Park the
  mouse and alt-tab or switch tab, and it plays forever — silently for YouTube
  (its previews are muted), audibly for us.
- Forcing `element.muted = false` leaves the player object believing it is
  muted (`isMuted() === true` while audio plays); that stale state follows you
  to the watch page.
- `stopVideo()` unloads the video and leaves a black tile reading `-0:01` if
  the preview is still on screen.
- `loadModule('captions')` on a player that already has captions **resets**
  them.
- Turning captions on also flips YouTube's own subtitles preference, so "off"
  must be enforced on each new preview.
- Browsers only allow **muted** autoplay: unmuting before playback starts can
  get `play()` rejected.
- youtube.com enforces **Trusted Types** (no `innerHTML` with strings).
- InnerTube from the page: **writes work, reads are not personalised** (see
  Dead ends).

---

## Conflicts with other extensions

The user runs **SponsorBlock 6.1.6** and **Enhancer for YouTube 3.0.19**
alongside this extension.

### SponsorBlock — YouTube kills previews when SponsorBlock edits them (v1.5.0)

- **Symptom:** hover previews on some videos, then on all videos, never
  started. "Nothing while hovering; on leaving, ~100 ms of sound." Same videos
  failed across refreshes and browser restarts.
- **Cause:** YouTube's preview watcher (see timeline) deactivated the preview
  3–4 ms after SponsorBlock added its segment bar (`ul#previewbar`) to
  YouTube's preview progress bar and its category label to
  `.ytp-tooltip-text-wrapper`.
- **How it was established:** pause hooked with stack traces showed the pause
  came from YouTube (`MutationObserver → deactivate → cancelPlayback`), not
  from us; a mutation log showed SponsorBlock's insertion as the last change
  before every cancel; blocking our own elements and forcing 1× speed changed
  nothing; **turning SponsorBlock off fixed it** (user test). Note: SponsorBlock
  inserts its bar even on videos with zero segments.
- **Fix:** `patcher.js` (page world, `document_start`, before YouTube's
  scripts) wraps `MutationObserver` and drops records that only concern
  SponsorBlock's elements or ours before YouTube's callbacks see them.
  SponsorBlock runs in its own isolated world with its own observers, so its
  segments, tooltip and autoskip keep working. Mixed records pass through.
- **Rejected alternatives:** hiding YouTube's preview bar so SponsorBlock falls
  back to ours (did not reliably stop the injection, and loses YouTube's bar);
  disabling SponsorBlock on previews (the user needs autoskip).
- **Remember:** never "fix" this by disabling or hiding SponsorBlock.

### SponsorBlock — segments on our fallback bar (v1.1.1, positive integration)

- SponsorBlock 6.x attaches its overlay to `#video-preview .ytp-progress-bar`
  — the class YouTube's old preview bar carried. When that bar disappeared
  (09-21) SponsorBlock had nowhere to draw. Our fallback bar carries the class
  `ytp-progress-bar` on purpose so SponsorBlock draws segments and the
  highlight marker on it. Keep that class.

### Enhancer for YouTube

- No conflict confirmed. Seen in the DOM (`efyt-*` classes on the player).
  It also manages volume, so it is the first suspect if "video starts muted"
  ever comes back.

---

## Problems and fixes

### v1.6.0 — feature: Ctrl pause and frame step on previews
Lone Ctrl (no other key/click/wheel while held) toggles pause through the
player API; `,` / `.` step one frame while paused, using the fps of the stream
actually playing (`getStatsForNerds().resolution`, fallback 30). Ignored while
typing. Also fixed: the CC button's delayed re-apply called `previewPlayer()`,
which only existed in `content.js` (other world) → silent `ReferenceError`.

### v1.5.0 — previews die with SponsorBlock on
See Conflicts → SponsorBlock.

### v1.4.4 — sound over a frozen thumbnail (self-inflicted)
- **Cause:** v1.4.3's "restart a stuck preview" nudge fired during YouTube's
  *normal* startup window (loaded, hovered, still at 0:00), starting the audio
  before YouTube revealed the video surface.
- **Fix:** removed the nudge.
- **Lesson:** do not ship speculative fixes that act during normal operation.

### v1.4.3 — "some previews never start"
- **Fixes (defensive, not confirmed as the cause — the real cause was the
  SponsorBlock conflict found in v1.5.0):** never unmute a preview before it
  is actually playing (muted-autoplay rule); add `yt-lockup-view-model` to
  `CARD_SEL`.

### v1.4.2 — clicking the preview progress bar seeks, then playback stops
- **Cause (stack-traced):** our own `stopAllPreviews`. The bar sits inside the
  card, so our "click on a card = opening the video" rule fired.
- **Fix:** exempt player controls inside a preview (YouTube's new and classic
  bars, its controls container, our fallback bar).

### v1.4.1 — thumbs-up could not show "already liked"
See Dead ends. Lookup removed.

### v1.4.0 — CC only switched on; focus no longer required
- CC "did nothing": turning captions on flips YouTube's own preference, so
  every new preview came back with captions. Fixed by enforcing the chosen
  state both ways on each preview (and not calling `loadModule` when already
  loaded — it resets captions).
- User request: previews play while hovered even if Brave is not focused
  (an occluded window is reported hidden, which still stops them).

### v1.3.0 — CC button; clicking the like button stopped playback
- Captions toggle rebuilt on the player API after YouTube removed its button.
- Like-click regression: v1.2.1 moved the button inside the card, so the
  card-click rule fired on it. Our controls are exempt (`CTL_SEL`).

### v1.2.1 — hovering the like button stopped playback; previews muted forever
- Button on `document.body` → moving onto it fired `mouseleave` on the card →
  YouTube teardown. Fix: mount it inside the thumbnail (that chain is
  `overflow: visible`) and swallow leave events whose `relatedTarget` is ours.
- A "user muted this" flag could get stuck with no mute button left to clear
  it. Removed: preview sound is unconditional (user's choice).

### v1.2.0 — feature: like from the thumbnail
InnerTube `like/like` with a `SAPISIDHASH` header (cookies alone → 401).
Confirmed landing in the account.

### v1.1.4 — unfocused hover: 1 s of sound, then a black `-0:01` tile
- v1.1.3 treated "window not focused" as "nobody watching", but hover works in
  an unfocused window. Fix: focus loss only mutes; never unmute when not
  allowed; pause first, `stopVideo()` only as a last resort.

### v1.1.3 — previews keep playing after you leave / doubled audio / muted watch page
- YouTube tears previews down only on `mouseleave` (see traps). Fix: a guard
  — a preview may play only while the tab is visible and the pointer is over
  a card; strays are stopped.
- The muted-element / unmuted-player desync leaked into the watch page; fixed
  with `player.unMute()`. Any card click was recorded as "user muted"; now only
  real mute controls counted (later removed entirely).

### v1.1.2 — extension error log: "Illegal invocation" and "Extension context invalidated"
- The 120 ms poll hit a non-media element matched by `… video` → per-element
  `try/catch` and an `instanceof HTMLMediaElement` check.
- The settings poll kept calling `chrome.storage` after an extension reload →
  stop when `chrome.runtime.id` is gone.

### v1.1.0 / v1.1.1 — draggable preview progress bar gone
YouTube's 09-21 rebuild (see timeline). Fallback bar drawn by `content.js`,
with `ytp-progress-bar` class for SponsorBlock; `preview.css` un-hides
YouTube's bar where it exists.

### Install: "Could not load JavaScript 'patcher.js'"
Files on disk were named `.jsc` while the manifest asked for `.js`. Renamed.

### Before 2026-09 (from commit history)
- Settings broke after a few seconds of slider dragging:
  `chrome.storage.sync`'s 120 writes/min quota. Moved to `storage.local`.
- Oscillating the `muted` property to fight YouTube's re-muting melted the
  CPU; reverted to blocking synchronously.
- Music previews: several attempts at detecting music cards (v1.0.3–v1.0.9);
  the working one is geometric — the preview is a shared overlay, never a
  child of the card, so test whether its centre falls inside a card that owns
  a music chip.

---

## Dead ends

- **"Is this video already liked?"** `/youtubei/v1/next` returns
  `likeStatus: INDIFFERENT` for videos in the account's own Liked list; a
  browse of that playlist comes back generic. Tried SAPISIDHASH /
  SAPISID1PHASH / SAPISID3PHASH together, with and without the api key, with
  watch-page context and full `X-Youtube-Client-*` headers. Writes work, reads
  are not personalised. Do not retry without a new idea.
- **Restarting stuck previews ourselves** (v1.4.3) — see v1.4.4.
- **Overlay buttons on `document.body`** — trigger YouTube's `mouseleave`
  teardown.

---

## How to debug this extension

- **Test in the real, signed-in browser**, with the extension installed (the
  claude-in-chrome tools drive it). A sandbox browser lacks the account, the
  other extensions and often refuses to start previews.
- **The tab must be visible.** Chrome defers media loading in background tabs
  (`readyState` stays 0) and this extension stops previews in hidden tabs.
- The first hover right after a page load often does not register — move
  away and back.
- **Find who paused it:** hook `HTMLMediaElement.prototype.pause` and log
  `new Error().stack` — frames from `chrome-extension://…/patcher.js` are ours,
  `player_es6…/base.js` and `ytmainappweb` are YouTube's.
- **Find what YouTube reacted to:** a `MutationObserver` on `document.body`
  logging records, plus a marker in the pause hook, shows the last DOM change
  before a cancel.
- **A/B extensions:** toggle SponsorBlock / Enhancer / this extension one at a
  time in `brave://extensions` and retry the same video.
- Check the extension's **Errors** page in `brave://extensions` after changes.
