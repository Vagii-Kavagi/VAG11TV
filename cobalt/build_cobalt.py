"""Builds VAG11TV for Cobalt from the TizenTubeCobalt base APK.

    python -I cobalt/build_cobalt.py base/cobalt-arm-v2.0.3.apk out/VAG11TV-cobalt.apk

The base is TizenTubeCobalt (github.com/reisxd/TizenTubeCobalt, BSD-3-Clause): YouTube's open-source
TV engine, Cobalt, built with a hook that loads one script into youtube.com/tv. The base is checked
against the published SHA-256, then changed only by same-length replacements, so no offsets move:

  - lib/armeabi-v7a/libchrobalt.so: the script address, to the VAG11 script (cobalt/vag11.user.js),
    served by jsDelivr from the public repo Vagii-Kavagi/VAG11TV-script. "@1" is the newest 1.x tag,
    so a script release needs no new APK, and only tagged versions are ever loaded.
  - AndroidManifest.xml: the package name, so it installs as its own app, and
    the label.

The old signature is dropped; the result is aligned and signed with this PC's debug key (the same
key as the WebView build), using zipalign and apksigner from the Android SDK.
"""
import hashlib
import os
import subprocess
import sys
import tempfile
import zipfile

BASE_SHA256 = "72a3527f520db3a1b414916ad96481244e451c41e272ae33344ae5e79abb37dd"  # v2.0.3 cobalt-arm.apk

OLD_URL = b"https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v="
NEW_URL = b"https://cdn.jsdelivr.net/gh/Vagii-Kavagi/VAG11TV-script@1/v.js?v="

OLD_PACKAGE = "io.gh.reisxd.tizentube.cobalt"
NEW_PACKAGE = "com.vag11.tv.cobalt.youtubetv"
OLD_LABEL = "TizenTube"
NEW_LABEL = "VAG11 TV "  # same length; the trailing space does not show

LIB = "lib/armeabi-v7a/libchrobalt.so"


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
    if digest != BASE_SHA256:
        raise SystemExit("base APK SHA-256 %s does not match the published %s" % (digest, BASE_SHA256))

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = tempfile.mkdtemp()
    unsigned, aligned = os.path.join(tmp, "unsigned.apk"), os.path.join(tmp, "aligned.apk")

    with zipfile.ZipFile(base) as zin, zipfile.ZipFile(unsigned, "w") as zout:
        for info in zin.infolist():
            name = info.filename
            if name.startswith("META-INF/") and name.rsplit(".", 1)[-1] in ("SF", "RSA", "DSA", "EC", "MF"):
                continue  # the old signature
            data = zin.read(name)
            if name == LIB:
                data = patch_url(data)
            elif name == "AndroidManifest.xml":
                data = patch_utf16(data, OLD_PACKAGE, NEW_PACKAGE, name, 2)  # package, file provider
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
