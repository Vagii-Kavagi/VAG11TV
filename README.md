# VAG11TV

A small Android TV app (`com.vag11.tv`) that opens YouTube's own TV interface, `youtube.com/tv`, signed
out, and adds one thing to it: **SponsorBlock**.

Nothing of YouTube's is copied into this repo. The interface is loaded from YouTube each time, in the
system WebView, and is left as it is. The additions are:

| File | What it does |
|---|---|
| `app/src/main/res/raw/settings_hook.js` | Adds a **SponsorBlock** entry to YouTube's Settings page. |
| `app/src/main/res/raw/sb_engine.js` | Skips reported segments, or shows a "Skip · press OK" button. |
| `app/src/main/res/raw/shell_hook.js` | Lets YouTube's own "exit" close the app. |
| `SponsorBlockSettingsActivity.java` | The SponsorBlock menu: on/off, and a mode for each kind of segment. |
| `WebShellActivity.java` | The WebView, the Back key, and the request to the SponsorBlock server. |

## Using it

- First start: choose **Watch as guest**. The TV remembers that.
- **Settings → SponsorBlock → Open SponsorBlock** opens the menu. OK changes a row: *Auto skip*,
  *Show a skip button* or *Off*. By default only sponsors are skipped.
- Segments come from the community database at `sponsor.ajay.app`. Only the first four characters of
  a hash of the video id are sent, so the server cannot tell which video is playing.
- Adverts are not touched. While one plays, nothing is skipped.

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
  When YouTube changes those, the Settings entry can disappear until `settings_hook.js` is updated;
  the rest of the page keeps working.
- A WebView is heavier than the stock app's engine, so it can feel slower on a 1 GB TV.
- Voice search is not wired up.
