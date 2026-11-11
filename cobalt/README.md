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

- Works on a MiTV-MSSP2: the script loads, "Ad blocking" and "SponsorBlock" appear in YouTube's
  Settings, and both menus work with the remote.
- TizenTubeCobalt 2.0.3, the base used so far, often fails to load its script on this TV ("JSDelivr
  is not reachable"), also unmodified; reisxd/TizenTubeCobalt#368 reports the same, gone on 2.0.2.
- SponsorBlock skipping is not confirmed on the TV yet.
