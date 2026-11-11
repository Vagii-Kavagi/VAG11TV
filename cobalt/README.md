# VAG11TV on Cobalt

VAG11TV built on YouTube's own open-source TV engine, Cobalt, instead of a WebView: the engine
plays video the way the stock YouTube app does (hardware video plane, instant start, 1080p and
60 fps), and loads one script into youtube.com/tv for the VAG11 additions.

- `vag11.user.js`: that script (ad blocking, the Settings entries and their menus, SponsorBlock).
  Released from the public repo [Vagii-Kavagi/VAG11TV-script](https://github.com/Vagii-Kavagi/VAG11TV-script)
  as `v.js`, tagged `1.x.y`; the app loads `cdn.jsdelivr.net/gh/Vagii-Kavagi/VAG11TV-script@1/v.js`.
- `build_cobalt.py`: makes the APK from the TizenTubeCobalt base (BSD-3-Clause), checked against
  its published SHA-256, by same-length replacements only (script address, package name, label),
  then aligns and signs it with this PC's debug key.

The base APK goes in `base/` and the result in `out/`; neither is committed.

## Status

Built on TizenTubeCobalt **2.0.2** (`base/cobalt-arm-v2.0.2.apk`, 97.2 MB, from its GitHub release).
2.0.3 often fails to load its script on the tested TV, also unmodified ("JSDelivr is not reachable");
reisxd/TizenTubeCobalt#368 reports the same, gone on 2.0.2. `build_cobalt.py` accepts either base.

Tried on a MiTV-MSSP2 (Android 9):
- 6 of 6 launches load the script, with no dialog; it installs as "VAG11 TV" (`com.vag11.tv.cobalt.youtubetv`).
- "Ad blocking" and "SponsorBlock" appear in YouTube's Settings; both menus work with the remote.
- SponsorBlock skips: a sponsor segment at 51.3 to 67.9 s was skipped and playback went on at 68.6 s.
  The skip goes through YouTube's player (`seekTo`); set on the video element alone it did not stick.
- SponsorBlock segments are marked on YouTube's progress bar (script 1.0.3), one mark per segment
  whose category is not Off, in SponsorBlock's colours.
- The script logs to the system log as warnings: `adb logcat -s cobalt:* | grep VAG11`.
