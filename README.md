# YT_Benn_tools

A personal Chrome/Brave extension (MV3) that improves YouTube: a persistent
progress bar on the watch page, and hover-preview thumbnails that actually
behave — with sound, a draggable seek bar, captions and a like button.

Extension lives in [`Benn_YTtools/`](Benn_YTtools). Requires Chrome/Brave 111+
(the patcher runs as a `world: "MAIN"` content script).

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `Benn_YTtools` folder
3. After pulling changes, hit **⟳** on the extension card (no need to reload
   when only switching between identical files)

## What it does

### Watch page
- A thin progress bar pinned to the bottom of the player, always visible —
  it does not fade out with the controls
- A `mm:ss - NN%` readout above it
- Colours, opacity and text size are configurable in the popup

### Hover previews (home page, search, sidebar)
- **Sound is on.** YouTube mutes preview playback; this unmutes it whenever
  the preview is allowed to be audible (see the rules below)
- **Seek bar** along the bottom of the preview: click or drag to seek, with a
  time tooltip. Used only when YouTube does not render its own bar — since
  Sept 2026 it builds the inline player with `controlsType = 0`, so usually it
  does not
- **SponsorBlock works on previews** — segments on the bar, the highlight
  marker, and autoskip. SponsorBlock 6.x attaches its overlay to
  `#video-preview .ytp-progress-bar`, so the fallback bar carries that class
  on purpose. When YouTube renders its own preview bar, SponsorBlock uses that
  instead — see "SponsorBlock vs YouTube's preview watcher" below for why that
  needed help
- **CC button** — toggles captions on previews. Global, remembered across
  previews and browser restarts. YouTube removed its own CC toggle from the
  inline preview controls in Sept 2026
- **Thumbs-up button** — likes the video without opening it, via the same
  InnerTube endpoint the watch page uses. Click again to remove the like
- **Preview speed** defaults to 1.5× (configurable); music previews are
  locked to 1×

### When a preview may play
A preview plays, with sound, only while **the tab is visible and the pointer
is over the thumbnail**. Window focus deliberately plays no part — hovering in
an unfocused window still plays. A preview is stopped when the pointer leaves
the card, the tab is hidden, or the window is fully covered by another app
(Chrome reports an occluded window as hidden). Clicking a video stops every
preview so none outlives the click.

This matters because YouTube only tears a preview down on `mouseleave`: park
the mouse on a thumbnail and alt-tab away, and its own preview plays forever —
silently for YouTube, audibly for us.

## Shortcuts

| Input | Action |
| --- | --- |
| `Shift` + wheel | Playback speed ± step (saved as the new preview default) |
| `Shift`+`Alt` + wheel | Scrub ± step seconds |
| `Ctrl` (left or right, on its own) | Pause / resume |
| `,` / `.` (while paused) | One frame back / forward |

All act on the preview under the cursor. `Ctrl` only counts when pressed and
released with nothing else in between, so `Ctrl`+C, `Ctrl`+click and
`Ctrl`+wheel zoom are unaffected; keys are ignored while typing in a field.
The frame step uses the frame rate of the stream actually playing.

## Settings (toolbar popup)

Played/unplayed bar colour + opacity, time-text colour + opacity, text size,
preview speed, scrub step, speed step. Changes apply instantly and are stored
in `chrome.storage.local` (not `sync` — sync's 120 writes/min quota silently
broke live colour updates while dragging sliders).

The captions toggle is the CC button itself, not a popup setting; it persists
the same way.

## How it works

| File | World | Job |
| --- | --- | --- |
| `patcher.js` | MAIN, `document_start` | Everything needing page context: `HTMLMediaElement` prototype patches for mute/volume, preview playback rules, wheel shortcuts, captions via the player API, the like/CC buttons, InnerTube calls |
| `content.js` | isolated, `document_idle` | Watch-page progress bar, the fallback preview seek bar, and the settings bridge to `chrome.storage` |
| `preview.css` | — | Un-hides `#player-controls`, which YouTube hides via `ytd-video-preview[hide-player-controls]` |
| `popup.html` / `popup.js` | — | Settings UI |

The two content scripts cannot see each other's variables, so they talk over
namespaced `postMessage` (`__benn_yt_settings__` down, `__benn_yt_save__` up);
only `content.js` touches `chrome.storage`.

## YouTube behaviour worth knowing (verified, dated)

The full chronological record — every problem, its cause, the fix, YouTube's
changes and the conflicts with SponsorBlock / Enhancer for YouTube — is in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md). Summary of the traps:

These cost real debugging time — check them before assuming a bug is ours.

- **2026-09-21** — YouTube rebuilt the inline hover-preview player with
  `controlsType = 0`. Its old `.ytp-progress-bar` is never rendered; the
  replacement is `yt-inline-player-controls` / `yt-progress-bar` inside
  `ytd-video-preview #player-controls`, hidden by `[hide-player-controls]`.
  Whether it renders at all varies by account.
- **2026-09-27** — that controls container renders with **no mute and no CC
  button** any more (both existed on 2026-09-22). The player API is untouched:
  `loadModule('captions')`, `toggleSubtitles()`, `isSubtitlesOn()` and
  `getOption/setOption('captions', …)` all still work.
- Calling `loadModule('captions')` when captions are **already loaded resets
  them** — only call it when the module is missing.
- Turning captions on also flips YouTube's own subtitles preference, so "off"
  has to be enforced on every new preview or it comes back.
- A preview is torn down only on pointer `mouseleave` of the card. An overlay
  button placed on `document.body` over a thumbnail therefore kills the
  preview when you move onto it — our buttons are mounted **inside** the
  thumbnail instead (that chain is `overflow: visible`, nothing is clipped).
- `stopVideo()` unloads the video and leaves a black tile reading `-0:01` if
  the preview is still on screen. Pause first; keep `stopVideo()` as a last
  resort.
- Forcing `element.muted = false` leaves the player object still believing it
  is muted (`isMuted() === true` while audio plays), and that stale state
  follows you to the watch page. Call the player's `unMute()` to resync.
- **Unmuting before playback starts can stop the preview from starting at
  all** — browsers only allow autoplay while muted. Previews must be left
  muted until they are actually rolling, then unmuted.
- Do not start a preview yourself either. Calling `playVideo()` during
  YouTube's startup window plays the audio while the preview surface is
  still hidden: sound over a frozen thumbnail.
- **SponsorBlock vs YouTube's preview watcher (Oct 2026).** While a preview
  plays, YouTube watches the page with a `MutationObserver`
  (`childList`, `subtree`) and *deactivates* the preview on certain DOM
  changes (`MutationObserver → deactivate → stopPlayer → cancelPlayback`).
  SponsorBlock adding its segment bar to the preview's progress bar and its
  label to the seek tooltip tripped it 3–4 ms later, so every preview died
  the moment it started; turning SponsorBlock off fixed it. `patcher.js` now
  wraps `MutationObserver` before YouTube's scripts load and drops records
  that only concern SponsorBlock's elements (or ours) before YouTube's
  callbacks see them. SponsorBlock runs in its own isolated world with its own
  observers, so it is unaffected — segments and autoskip keep working.
- Testing previews in a **background tab** is meaningless: Chrome defers media
  loading in tabs that are not visible (`readyState` stays 0), and this
  extension stops previews in hidden tabs anyway.
- youtube.com enforces **Trusted Types**: build injected icons with
  `createElementNS`, never `innerHTML`.
- **InnerTube from the page: writes work, reads are not personalised.**
  `like/like` with a `SAPISIDHASH` header does like the video (confirmed
  landing in the account). But `next` reports `likeStatus: INDIFFERENT` for
  videos that are in the account's own Liked list, and browsing that playlist
  comes back generic — tested with all three auth hashes together, with and
  without the api key, with watch-page context and full `X-Youtube-Client-*`
  headers.

## Known limitations

- **The thumbs-up cannot show whether you already liked a video** (see above);
  it starts neutral and reflects only likes made through it in that session.
- Captions only appear where the video actually has them (auto-generated
  count).
