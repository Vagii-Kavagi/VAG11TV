"""Builds VAG11TV for Cobalt from the TizenTubeCobalt base APK.

    python -I cobalt/build_cobalt.py base/cobalt-arm-v2.0.2.apk out/VAG11TV-cobalt.apk
    python -I cobalt/build_cobalt.py --sha256 <hex> --engine 2.0.4 --script 1.1.6 base.apk out.apk

A base that is not in BASES (a new engine release) is built only with --sha256, the digest GitHub publishes
for that release asset, which the file must match.

The base is TizenTubeCobalt (github.com/reisxd/TizenTubeCobalt, BSD-3-Clause): YouTube's open-source
TV engine, Cobalt, built with a hook that loads one script into youtube.com/tv. The base is checked
against the published SHA-256, then changed only by same-length replacements, so no offsets move:

  - lib/armeabi-v7a/libchrobalt.so: the script address, to the VAG11 script (cobalt/vag11.user.js),
    served by jsDelivr from the public repo Vagii-Kavagi/VAG11TV-script, at the exact tag in
    SCRIPT_VERSION.
  - AndroidManifest.xml: the package name, so it installs as its own app, and
    the label.
  - the launcher icon and TV banner: VAG11's (cobalt/art), same files and sizes.
  - the updater (cobalt/updater): compiled here into one more classesN.dex, and the manifest's
    androidx FileProvider entry renamed to its same-length subclass, which registers the platform
    service com.vag11.tv.updater with the engine for the script's Updates menu.

The old signature is dropped; the result is aligned and signed with zipalign and apksigner from the
Android SDK. With VAG11_KEYSTORE set (and VAG11_KEYSTORE_PASS), it is signed with VAG11's own key and
cobalt/vag11.lineage, the handover from this PC's debug key that signed the first releases: Android 9
and later then installs it over an older VAG11 without uninstalling. Only the v3 signature is written
(the older schemes would need the old key), so these builds need Android 9 or later. Without
VAG11_KEYSTORE, the debug key signs, as before.
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
SCRIPT_VERSION = "1.2.1"
NEW_URL = ("https://cdn.jsdelivr.net/gh/Vagii-Kavagi/VAG11TV-script@%s/v.js?v=" % SCRIPT_VERSION).encode()

OLD_PACKAGE = "io.gh.reisxd.tizentube.cobalt"
NEW_PACKAGE = "com.vag11.tv.cobalt.youtubetv"
OLD_LABEL = "TizenTube"
NEW_LABEL = "VAG11 TV "  # same length; the trailing space does not show

LIB = "lib/armeabi-v7a/libchrobalt.so"

# The updater's entry point takes the place of the engine's FileProvider (and still is one): same length.
OLD_PROVIDER = "androidx.core.content.FileProvider"
NEW_PROVIDER = "com.vag11.tv.updater.FileProvider1"
UPDATER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "updater")

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


def sdk_root():
    return os.environ.get("ANDROID_HOME") or os.path.join(os.environ["LOCALAPPDATA"], "Android", "Sdk")


def android_jar():
    platforms = os.path.join(sdk_root(), "platforms")
    for v in sorted(os.listdir(platforms), key=lambda n: int("".join(c for c in n if c.isdigit()) or 0), reverse=True):
        jar = os.path.join(platforms, v, "android.jar")
        if os.path.exists(jar):
            return jar
    raise SystemExit("no android.jar in %s" % platforms)


def java_files(root):
    return [os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs if f.endswith(".java")]


def build_updater_dex(tmp):
    """Compiles cobalt/updater against stand-ins for the engine's classes, which stay out of the dex."""
    jdk_bin = os.path.join(os.environ["JAVA_HOME"], "bin")
    javac, jar = os.path.join(jdk_bin, "javac"), os.path.join(jdk_bin, "jar")
    lib = android_jar()
    stubs, classes, out = (os.path.join(tmp, n) for n in ("stubs", "classes", "dex"))
    for d in (stubs, classes, out):
        os.makedirs(d)
    common = ["-source", "8", "-target", "8", "-bootclasspath", lib, "-encoding", "UTF-8", "-nowarn", "-Xlint:-options"]
    subprocess.check_call([javac] + common + ["-d", stubs] + java_files(os.path.join(UPDATER, "stubs")))
    subprocess.check_call([javac] + common + ["-cp", stubs, "-d", classes] + java_files(os.path.join(UPDATER, "src")))
    stubs_jar, classes_jar = os.path.join(tmp, "stubs.jar"), os.path.join(tmp, "classes.jar")
    subprocess.check_call([jar, "cf", stubs_jar, "-C", stubs, "."])
    subprocess.check_call([jar, "cf", classes_jar, "-C", classes, "."])
    subprocess.check_call([sdk_tool("d8"), "--release", "--min-api", "24", "--lib", lib,
                           "--classpath", stubs_jar, "--output", out, classes_jar])
    return os.path.join(out, "classes.dex")


def sdk_tool(name):
    tools = os.path.join(sdk_root(), "build-tools")
    version = sorted(os.listdir(tools))[-1]
    for ext in (".exe", ".bat", ""):
        path = os.path.join(tools, version, name + ext)
        if os.path.exists(path):
            return path
    raise SystemExit("%s not found in %s" % (name, tools))


def main(base, out, expected_sha256=None, engine=None, script=None):
    global NEW_URL
    if script:
        if len(script) > 5:
            raise SystemExit("script version %r is longer than five characters" % script)
        NEW_URL = ("https://cdn.jsdelivr.net/gh/Vagii-Kavagi/VAG11TV-script@%s/v.js?v=" % script).encode()
    with open(base, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    if digest in BASES:
        version, package_count = BASES[digest]
    elif expected_sha256 and digest == expected_sha256.lower().replace("sha256:", ""):
        version, package_count = engine or "unknown", None   # counted in the manifest below
    else:
        raise SystemExit("base APK SHA-256 %s is not one of the published, checked bases" % digest)
    print("base: TizenTubeCobalt %s, script %s" % (version, script or SCRIPT_VERSION))

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = tempfile.mkdtemp()
    unsigned, aligned = os.path.join(tmp, "unsigned.apk"), os.path.join(tmp, "aligned.apk")

    # apksigner and javac run on Java: the JDK next to the SDK, as install-to-tv.ps1 uses, unless one is set.
    jdk = os.environ.get("JAVA_HOME") or os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "jdk17")
    os.environ["JAVA_HOME"] = jdk
    os.environ["PATH"] = os.path.join(jdk, "bin") + os.pathsep + os.environ.get("PATH", "")
    updater_dex = build_updater_dex(tmp)

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
                count = package_count
                if count is None:
                    # A new engine: every place the package name is, as long as there is at least one.
                    count = data.count(OLD_PACKAGE.encode("utf-16-le"))
                    if count < 1:
                        raise SystemExit("package name not found in the manifest")
                data = patch_utf16(data, OLD_PACKAGE, NEW_PACKAGE, name, count)  # package, providers
                data = patch_utf16(data, OLD_LABEL, NEW_LABEL, name, 1)
                data = patch_utf16(data, OLD_PROVIDER, NEW_PROVIDER, name, 1)
            # resources.arsc keeps the base's package name, as Android's own renaming does
            # (aapt --rename-manifest-package): renamed there too, the engine fails to load the
            # script (measured on a MiTV-MSSP2: the "JSDelivr is not reachable" dialog).
            copy = zipfile.ZipInfo(name, info.date_time)
            copy.compress_type = info.compress_type
            copy.external_attr = info.external_attr
            zout.writestr(copy, data)
        # The updater as the next dex in line (Android loads classes.dex, classes2.dex, ... in order).
        numbers = [int(n[7:-4] or 1) for n in zin.namelist() if n.startswith("classes") and n.endswith(".dex")]
        dex_name = "classes%d.dex" % (max(numbers) + 1)
        with open(updater_dex, "rb") as f:
            zout.writestr(zipfile.ZipInfo(dex_name, (2026, 1, 1, 0, 0, 0)), f.read(), zipfile.ZIP_DEFLATED)
        print("updater: %s" % dex_name)

    subprocess.check_call([sdk_tool("zipalign"), "-f", "-p", "4", unsigned, aligned])
    own = os.environ.get("VAG11_KEYSTORE")
    if own:
        password = "env:VAG11_KEYSTORE_PASS"
        lineage = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vag11.lineage")
        subprocess.check_call([sdk_tool("apksigner"), "sign", "--ks", own, "--ks-pass", password,
                               "--key-pass", password, "--ks-key-alias", "vag11",
                               "--lineage", lineage, "--rotation-min-sdk-version", "28",
                               # The old key stays on the PC that made it, so only the v3 signature (Android 9
                               # and later), the one that carries the handover, is written.
                               "--min-sdk-version", "28", "--v1-signing-enabled", "false",
                               "--v2-signing-enabled", "false", "--v3-signing-enabled", "true",
                               "--out", out, aligned])
    else:
        keystore = os.path.join(os.path.expanduser("~"), ".android", "debug.keystore")
        subprocess.check_call([sdk_tool("apksigner"), "sign", "--ks", keystore, "--ks-pass", "pass:android",
                               "--key-pass", "pass:android", "--ks-key-alias", "androiddebugkey",
                               "--out", out, aligned])
    subprocess.check_call([sdk_tool("apksigner"), "verify", "--print-certs", out])
    print("built %s (%d bytes)" % (out, os.path.getsize(out)))


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(usage=__doc__)
    ap.add_argument("base")
    ap.add_argument("out")
    ap.add_argument("--sha256", help="the digest GitHub publishes for a base not in BASES")
    ap.add_argument("--engine", help="the engine version, for the log")
    ap.add_argument("--script", help="the VAG11TV-script tag to load (default %s)" % SCRIPT_VERSION)
    a = ap.parse_args()
    main(a.base, a.out, a.sha256, a.engine, a.script)
