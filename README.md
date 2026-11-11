# VAG11TV

A small Android TV app (`com.vag11.tv`) that opens YouTube's own TV interface, `youtube.com/tv`, signed
out, and adds two things to it: an **ad blocker** and **SponsorBlock**.

Nothing of YouTube's is copied into this repo. The interface is loaded from YouTube each time, in the
system WebView, and is left as it is. The additions are:

| File | What it does |
|---|---|
| `app/src/main/res/raw/settings_hook.js` | Adds the **Ad blocking** and **SponsorBlock** entries to YouTube's Settings page. |
| `app/src/main/res/raw/ad_block.js` | Takes the adverts out of the data YouTube sends, before the page reads it. |
| `app/src/main/res/raw/player_tune.js` | Keeps the player to formats this TV plays smoothly, and connects to the video server early. |
| `app/src/main/res/raw/sb_engine.js` | Skips reported segments, or shows a "Skip · press OK" button. |
| `app/src/main/res/raw/shell_hook.js` | Lets YouTube's own "exit" close the app. |
| `SettingsActivity.java` | The two menus: the ad blocker's switch, and SponsorBlock's on/off with a mode for each kind of segment. |
| `WebShellActivity.java` | The WebView, the Back key, the blank video placeholder, and the request to the SponsorBlock server. |

## Using it

- First start: choose **Watch as guest**. The TV remembers that.
- **Settings → SponsorBlock → Open SponsorBlock** opens the menu. OK changes a row: *Auto skip*,
  *Show a skip button* or *Off*. By default only sponsors are skipped.
- Segments come from the community database at `sponsor.ajay.app`. Only the first four characters of
  a hash of the video id are sent, so the server cannot tell which video is playing.
- **Settings → Ad blocking → Open ad blocking** has one switch, on by default. It removes adverts
  before and during videos, the Home banner and Sponsored tiles. A change applies to the next video
  or page you open.
- With ad blocking off, SponsorBlock skips nothing while an advert plays.

## Build and install

Needs JDK 17, the Android SDK (platform 34, build-tools 34.0.0) and `adb` authorised on the TV.

```powershell
.\install-to-tv.ps1 -TvHost <tv ip>
```

`-DebugBuild` installs a debuggable build with WebView inspection switched on.

Release builds are signed with the debug key of the PC that builds them, unless a `keystore.properties`
(never committed) names a release key: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.

## Tested on

Xiaomi MiTV-MSSP2, Android TV 9, Android System WebView 138.

## Known limits

- It depends on how YouTube's TV page is built today (its settings data and its command resolver).
  When YouTube changes those, the Settings entries can disappear until `settings_hook.js` is updated,
  and adverts can come back until `ad_block.js` is; the rest of the page keeps working.
- A WebView is heavier than the stock app's engine, so it can feel slower on a 1 GB TV.
- Video is drawn on the same surface as the interface, which is 720p on the tested TV, so `player_tune.js`
  does not let the player pick anything larger. AV1 is left out because the WebView decodes it in software.
- A video starts about 2 seconds after OK is pressed. Most of that is YouTube's own request for the
  video's data; the shell cannot shorten it.
- Voice search is not wired up.

## Starting sooner: preloading

Most of the wait after OK is YouTube's video servers: two round trips of about a second each from the
tested TV. YouTube's TV player can load a video ahead of time, the way the stock apps feel instant,
but the TV page never asks it to. `preload.js` does: a video tile that stays selected for half a
second is preloaded (not on the watch page, at most one every 1.5 s). Measured with the remote,
OK to first picture: 0.8 to 2.2 s, against about 5 s without.

## Experimental: native picture (branch `native-video`)

On this branch the picture is not drawn by the WebView. YouTube's player still chooses the quality,
downloads the video and draws its controls, but the H.264 video it would hand to the page's own
decoder is taken over by `native_video.js`, split into frames and decoded by `NativeVideo.java` onto
a surface under the page, in step with the page's clock. Sound stays in the page. The point is to get
past the 720p surface: 1080p plays on the TV's video plane.

- The page is told its pixels are dense enough for 1080p (YouTube offers nothing taller than the
  area it draws into), and the player is asked for 1080p for as long as a video plays.
- Frames are handed on as soon as their bytes arrive, not a whole fragment at a time.
- Measured on the tested TV: 1080p H.264 at 25 frames a second with no dropped frames once started;
  a few are dropped in the first second.
- YouTube makes H.264 only up to 480p or 720p for many videos (their 1080p is VP9 or AV1 only), so
  those play below 1080p here. Streams wider than 1920 or taller than 1088 are left out: the TV's
  decoder refuses them.
- 60 frames a second: the player bans every format above 32 fps unless the browser turns down an
  absurd frame rate in `MediaSource.isTypeSupported`. A WebView does not, so the page answers that
  probe as a TV engine would. Measured: H.264 1080p60 with no dropped frames over 20 seconds.
- The tested TV has a 1366x768 panel, so 1080p cannot look sharper there. This is for a 1080p TV.
- `install-to-tv.ps1` installs to internal storage (`adb install -f`), also when the TV puts new apps
  on a USB drive: on slow flash the app's data and the WebView's cache made playback stutter.
- There is no menu entry to turn it off yet, and adverts or Shorts have not been tried with it.
