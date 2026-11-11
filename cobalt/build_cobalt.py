"""Builds VAG11TV for Cobalt from the TizenTubeCobalt base APK.

    python -I cobalt/build_cobalt.py base/cobalt-arm-v2.0.2.apk out/VAG11TV-cobalt.apk

The base is TizenTubeCobalt (github.com/reisxd/TizenTubeCobalt, BSD-3-Clause): YouTube's open-source
TV engine, Cobalt, built with a hook that loads one script into youtube.com/tv. The base is checked
against the published SHA-256, then changed only by same-length replacements, so no offsets move:

  - lib/armeabi-v7a/libchrobalt.so: the script address, to the VAG11 script (cobalt/vag11.user.js),
    served by jsDelivr from the public repo Vagii-Kavagi/VAG11TV-script, at the exact tag in
    SCRIPT_VERSION.
  - AndroidManifest.xml: the package name, so it installs as its own app, and
    the label.
  - the launcher icon and TV banner: VAG11's (cobalt/art), same files and sizes.

The old signature is dropped; the result is aligned and signed with this PC's debug key (the same
key as the WebView build), using zipalign and apksigner from the Android SDK.
"""
import hashlib
import os
import subprocess
import sys
import tempfile
import zipfile

# Bases checked against their published SHA-256, with how often the package name is in the manifest.
# 2.0.3 often fails to load its script ("JSDelivr is not reachable"), also unmodified, on a
# MiTV-MSSP2 (reisxd/TizenTubeCobalt#368 reports the same, gone on 2.0.2), so 2.0.2 is the one used.
BASES = {
    "ff90c6e85c37246b809cca80282910509782c1384eccfbb6066da3b497dd9fd2": ("2.0.2", 3),
    "72a3527f520db3a1b414916ad96481244e451c41e272ae33344ae5e79abb37dd": ("2.0.3", 2),
}

OLD_URL = b"https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v="
# The script version this build loads. Exact, not "@1": jsDelivr's version aliases lagged by hours
# (measured 2026-11-11), which left the TV on an older script. A release is a tag in
# Vagii-Kavagi/VAG11TV-script and a rebuild here. Five characters at most, or the address no longer
# fits in the engine's 69 bytes.
SCRIPT_VERSION = "1.1.6"
NEW_URL = ("https://cdn.jsdelivr.net/gh/Vagii-Kavagi/VAG11TV-script@%s/v.js?v=" % SCRIPT_VERSION).encode()

OLD_PACKAGE = "io.gh.reisxd.tizentube.cobalt"
NEW_PACKAGE = "com.vag11.tv.cobalt.youtubetv"
OLD_LABEL = "TizenTube"
NEW_LABEL = "VAG11 TV "  # same length; the trailing space does not show

LIB = "lib/armeabi-v7a/libchrobalt.so"

# The launcher artwork (cobalt/art, drawn by make_art.ps1) in place of TizenTube's, file for file
# at the same pixel sizes, so the resource table needs no change.
ART = os.path.join(os.path.dirname(os.path.abspath(__file__)), "art")
ART_FILES = {
    "res/mipmap-mdpi-v4/ic_app": "ic_app_80.png",
    "res/mipmap-hdpi-v4/ic_app": "ic_app_120.png",
    "res/mipmap-xhdpi-v4/ic_app": "ic_app_160.png",
    "res/mipmap-xxhdpi-v4/ic_app": "ic_app_240.png",
    "res/mipmap-xxxhdpi-v4/ic_app": "ic_app_320.png",
    "res/drawable/app_banner": "app_banner_160.png",
    "res/drawable-hdpi-v4/app_banner": "app_banner_240.png",
    "res/drawable-xhdpi-v4/app_banner": "app_banner_320.png",
    "res/drawable-xxhdpi-v4/app_banner": "app_banner_480.png",
    "res/drawable-xxxhdpi-v4/app_banner": "app_banner_640.png",
}


def same_length(old, new):
    if len(new) > len(old):
        raise SystemExit("replacement longer than the original: %r" % new)
    return new


def patch_url(data):
    # The engine appends a version after "?v=", so padding goes there, where it is only a query.
    new = same_length(OLD_URL, NEW_URL) + b"0" * (len(OLD_URL) - len(NEW_URL))
    if data.count(OLD_URL) != 1:
        raise SystemExit("script address found %d times in %s, expected once" % (data.count(OLD_URL), LIB))
    return data.replace(OLD_URL, new)


def patch_utf16(data, old, new, name, expected):
    o, n = old.encode("utf-16-le"), same_length(old, new).encode("utf-16-le")
    if len(o) != len(n):
        raise SystemExit("%r and %r differ in length" % (old, new))
    count = data.count(o)
    if count != expected:
        raise SystemExit("%r found %d times in %s, expected %d" % (old, count, name, expected))
    return data.replace(o, n)


def sdk_tool(name):
    sdk = os.environ.get("ANDROID_HOME") or os.path.join(os.environ["LOCALAPPDATA"], "Android", "Sdk")
    tools = os.path.join(sdk, "build-tools")
    version = sorted(os.listdir(tools))[-1]
    for ext in (".exe", ".bat", ""):
        path = os.path.join(tools, version, name + ext)
        if os.path.exists(path):
            return path
    raise SystemExit("%s not found in %s" % (name, tools))


def main(base, out):
    with open(base, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    if digest not in BASES:
        raise SystemExit("base APK SHA-256 %s is not one of the published, checked bases" % digest)
    version, package_count = BASES[digest]
    print("base: TizenTubeCobalt %s" % version)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = tempfile.mkdtemp()
    unsigned, aligned = os.path.join(tmp, "unsigned.apk"), os.path.join(tmp, "aligned.apk")

    with zipfile.ZipFile(base) as zin, zipfile.ZipFile(unsigned, "w") as zout:
        for info in zin.infolist():
            name = info.filename
            if name.startswith("META-INF/") and name.rsplit(".", 1)[-1] in ("SF", "RSA", "DSA", "EC", "MF"):
                continue  # the old signature
            data = zin.read(name)
            if name in ART_FILES:
                with open(os.path.join(ART, ART_FILES[name]), "rb") as art:
                    data = art.read()
            elif name == LIB:
                data = patch_url(data)
            elif name == "AndroidManifest.xml":
                data = patch_utf16(data, OLD_PACKAGE, NEW_PACKAGE, name, package_count)  # package, providers
                data = patch_utf16(data, OLD_LABEL, NEW_LABEL, name, 1)
            # resources.arsc keeps the base's package name, as Android's own renaming does
            # (aapt --rename-manifest-package): renamed there too, the engine fails to load the
            # script (measured on a MiTV-MSSP2: the "JSDelivr is not reachable" dialog).
            copy = zipfile.ZipInfo(name, info.date_time)
            copy.compress_type = info.compress_type
            copy.external_attr = info.external_attr
            zout.writestr(copy, data)

    # apksigner runs on Java: the JDK next to the SDK, as install-to-tv.ps1 uses, unless one is set.
    jdk = os.environ.get("JAVA_HOME") or os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "jdk17")
    os.environ["JAVA_HOME"] = jdk
    os.environ["PATH"] = os.path.join(jdk, "bin") + os.pathsep + os.environ.get("PATH", "")

    subprocess.check_call([sdk_tool("zipalign"), "-f", "-p", "4", unsigned, aligned])
    keystore = os.path.join(os.path.expanduser("~"), ".android", "debug.keystore")
    subprocess.check_call([sdk_tool("apksigner"), "sign", "--ks", keystore, "--ks-pass", "pass:android",
                           "--key-pass", "pass:android", "--ks-key-alias", "androiddebugkey",
                           "--out", out, aligned])
    subprocess.check_call([sdk_tool("apksigner"), "verify", out])
    print("built %s (%d bytes)" % (out, os.path.getsize(out)))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
