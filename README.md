# VAG11TV

YouTube for Android TV, signed out, with **ad blocking** and **SponsorBlock** built into YouTube's own
Settings. It runs on Cobalt, the open-source engine behind YouTube's TV app, so videos start instantly
and play on the TV's hardware video decoder, up to 1080p at 60 fps.

> **For Android TV and Google TV devices with an ARMv7 (32-bit ARM) processor**: Android 9 or newer for
> releases from `v1.1.6-engine-2.0.2` on; Android 7.0 and 8 can use release `v1.1.6`.
> 64-bit ARM TVs and boxes run it too, as they also run 32-bit ARM apps. It does not run on x86 devices,
> and it is made for a TV remote, not a phone or a touchscreen.

## Install

1. Download `VAG11TV-<version>-armeabi-v7a.apk` from [Releases](https://github.com/Vagii-Kavagi/VAG11TV/releases).
2. Copy it to the TV (a USB stick, [LocalSend](https://localsend.org) or the Downloader app) and open it
   there, or install it from a computer with `adb install VAG11TV-<version>-armeabi-v7a.apk`.
3. Open **VAG11 TV** from the TV's apps. It installs beside the stock YouTube app and doesn't replace it.

## Using it

- **Settings → Ad blocking**: one switch, on by default. It takes out adverts before and during videos,
  the Home banner and the Sponsored tiles.
- **Settings → SponsorBlock**: on or off, and for each kind of segment (sponsor, self-promotion,
  intro, outro and more) *Auto skip*, *Show a skip button* or *Off*. Segments are marked on the
  progress bar in SponsorBlock's colours.
- Segments come from the community database at `sponsor.ajay.app`. Only the first four characters of a
  hash of the video id are sent, so the server cannot tell which video is playing.

## Updates

- **In the app: Settings → Updates.** It checks the releases here. With nothing newer it says *You're done here*;
  otherwise it shows the new version with **Download and install**. The download is checked against the SHA-256
  GitHub publishes, then Android asks you to press **Install**, once per update. It is an update of the same
  app, so your sign-in and settings stay. The first time, Android asks you to allow VAG11 TV under *Install
  unknown apps*. *Include untested builds* also offers the automatic engine builds below. Releases before
  `v1.2.1-engine-2.0.2` don't have the menu, so install that one by hand once.
- **New engine versions are built automatically.** Once a day, [Engine watch](.github/workflows/engine-watch.yml)
  checks [TizenTubeCobalt](https://github.com/reisxd/TizenTubeCobalt/releases) for a new engine. When one is
  out, it builds VAG11 on it and publishes it here as a **pre-release marked untested**, named
  `v<script>-engine-<engine>`. To get an email, use **Watch → Custom → Releases** on this repo.
- **Try it, then promote it.** Install the APK over your current VAG11; it keeps your sign-in and settings. If it
  works, open the release on GitHub, choose *Edit*, tick *Set as the latest release* and untick *Set as a
  pre-release*. If it doesn't, reinstall the latest release over it.
- **Engines that are known not to work** are listed in `cobalt/engine-skip.txt` and skipped (2.0.3 is there).
  A build the script refuses to patch opens an issue instead of a release.
- **Script fixes** (when YouTube changes how ads arrive) are a new tag in VAG11TV-script, then a new
  `SCRIPT_VERSION` in `cobalt/build_cobalt.py`. The next build, or *Run workflow* in the Actions tab, picks it up.

Releases are signed with VAG11's own key, kept as an encrypted secret of this repo. `cobalt/vag11.lineage`
hands over from the key that signed the first releases, so Android 9 and later install them over `v1.1.6`
without uninstalling. Only that newer signature scheme is used, which is why these releases need Android 9.

## How it is made

`cobalt/build_cobalt.py` takes the [TizenTubeCobalt](https://github.com/reisxd/TizenTubeCobalt) 2.0.2
APK (BSD-3-Clause), checks it against its published SHA-256, and changes only same-length strings: the
address of the script it loads, the package name (`com.vag11.tv.cobalt.youtubetv`) and the label. It swaps
in the VAG11 icon and banner, then aligns and signs the APK. The script, `cobalt/vag11.user.js`, is
released from [Vagii-Kavagi/VAG11TV-script](https://github.com/Vagii-Kavagi/VAG11TV-script) and each build
loads one exact version of it. [cobalt/README.md](cobalt/README.md) has the details and what was tested.

Nothing of YouTube's is copied into this repo: the interface is loaded from YouTube each time.
VAG11TV is not affiliated with YouTube or Google.

## Tested on

Xiaomi MiTV-MSSP2 (32", 1366×768), Android TV 9, MediaTek MT5895.

---

## The older WebView version

The repo's first version, still in `app/`, is a WebView shell (`com.vag11.tv`) around `youtube.com/tv`
with the same two additions. It is kept for reference; the Cobalt build above plays video much better.

### Using it

- First start: choose **Watch as guest**. The TV remembers that.
- **Settings → SponsorBlock → Open SponsorBlock** opens the menu. OK changes a row: *Auto skip*,
  *Show a skip button* or *Off*. By default only sponsors are skipped.
- Segments come from the community database at `sponsor.ajay.app`. Only the first four characters of
  a hash of the video id are sent, so the server cannot tell which video is playing.
- **Settings → Ad blocking → Open ad blocking** has one switch, on by default. It removes adverts
  before and during videos, the Home banner and Sponsored tiles. A change applies to the next video
  or page you open.
- With ad blocking off, SponsorBlock skips nothing while an advert plays.

### Build and install

Needs JDK 17, the Android SDK (platform 34, build-tools 34.0.0) and `adb` authorised on the TV.

```powershell
.\install-to-tv.ps1 -TvHost <tv ip>
```

`-DebugBuild` installs a debuggable build with WebView inspection switched on.

Release builds are signed with the debug key of the PC that builds them, unless a `keystore.properties`
(never committed) names a release key: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.

### Tested on

Xiaomi MiTV-MSSP2, Android TV 9, Android System WebView 138.

### Known limits

- It depends on how YouTube's TV page is built today (its settings data and its command resolver).
  When YouTube changes those, the Settings entries can disappear until `settings_hook.js` is updated,
  and adverts can come back until `ad_block.js` is; the rest of the page keeps working.
- A WebView is heavier than the stock app's engine, so it can feel slower on a 1 GB TV.
- Video is drawn on the same surface as the interface, which is 720p on the tested TV, so `player_tune.js`
  does not let the player pick anything larger. AV1 is left out because the WebView decodes it in software.
- A video starts about 2 seconds after OK is pressed. Most of that is YouTube's own request for the
  video's data; the shell cannot shorten it.
- Voice search is not wired up.
