package com.vag11.tv.updater;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * The work behind the VAG11 script's Updates menu (reached through UpdaterService). It downloads a release APK from GitHub, checks it against
 * the SHA-256 GitHub publishes and that it is VAG11 itself, then hands it to Android's installer as an update of
 * this app, on internal storage. Android asks once ("Install"); being an update, the sign-in and settings stay.
 * The script asks for state() while this runs.
 */
final class Vag11Updater {
    private static final String TAG = FileProvider1.TAG;
    private static final String HOST = "https://github.com/Vagii-Kavagi/VAG11TV/releases/download/";

    private final Activity activity;
    private final Context app;
    private volatile String state = "idle";   // idle, downloading, verifying, installing, confirm, error
    private volatile long done, total;
    private volatile String message = "";
    private volatile boolean cancelled;
    private Thread worker;

    Vag11Updater(Activity activity) {
        this.activity = activity;
        this.app = activity.getApplicationContext();
    }

    /** {"versionName": the engine version, "versionCode", "package"}. */
    public String appInfo() {
        try {
            PackageInfo p = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            return new JSONObject().put("versionName", p.versionName).put("versionCode", p.versionCode)
                    .put("package", p.packageName).toString();
        } catch (PackageManager.NameNotFoundException | JSONException e) {
            return "{}";
        }
    }

    /** Whether Android lets this app install updates (Settings, "Install unknown apps"). */
    public boolean canInstall() {
        return Build.VERSION.SDK_INT < 26 || app.getPackageManager().canRequestPackageInstalls();
    }

    /** Opens the page where the owner allows VAG11 to install updates. */
    public void openInstallSetting() {
        activity.runOnUiThread(new Runnable() { @Override public void run() {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + app.getPackageName()));
            try {
                activity.startActivity(i);
            } catch (RuntimeException e) {
                try {
                    activity.startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS));
                } catch (RuntimeException ignored) {
                    message = "Open Settings, then Security, and allow VAG11 TV to install apps.";
                }
            }
        } });
    }

    /** {"state", "done", "total", "message"}, for the menu's progress. */
    public String state() {
        try {
            return new JSONObject().put("state", state).put("done", done).put("total", total)
                    .put("message", message).toString();
        } catch (JSONException e) {
            return "{\"state\":\"error\"}";
        }
    }

    /**
     * Downloads and installs one release asset: its path under the repo's releases/download/ (tag/file name), and
     * the SHA-256 GitHub publishes for it. Returns "started", or why not.
     */
    public synchronized String start(String path, String sha256) {
        if (worker != null && worker.isAlive()) return "busy";
        if (path == null || !path.matches("[A-Za-z0-9._+-]+/[A-Za-z0-9._+-]+\\.apk")) return "bad path";
        final String want = sha256 == null ? "" : sha256.toLowerCase().replace("sha256:", "");
        if (!want.matches("[0-9a-f]{64}")) return "no checksum";
        cancelled = false;
        done = 0;
        total = 0;
        message = "";
        state = "downloading";
        final String url = HOST + path;
        worker = new Thread(new Runnable() { @Override public void run() { Vag11Updater.this.run(url, want); } }, "vag11-update");
        worker.start();
        return "started";
    }

    public void cancel() {
        cancelled = true;
    }

    private void run(String url, String want) {
        File apk = new File(app.getCacheDir(), "vag11-update.apk");
        try {
            download(url, apk, want);
            if (cancelled) throw new IOException("Cancelled");
            state = "verifying";
            PackageInfo p = app.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
            if (p == null || !app.getPackageName().equals(p.packageName)) {
                throw new IOException("The download is not VAG11 TV");
            }
            state = "installing";
            install(apk);
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "update failed", e);
            message = e.getMessage() == null ? e.toString() : e.getMessage();
            state = "error";
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
        }
    }

    private void download(String url, File out, String want) throws IOException {
        MessageDigest sha;
        try {
            sha = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        HttpURLConnection c = null;
        for (int hop = 0; hop < 5; hop++) {   // GitHub answers with a redirect to its file host
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "VAG11-TV-updater");
            int code = c.getResponseCode();
            if (code / 100 == 3) {
                String next = c.getHeaderField("Location");
                c.disconnect();
                if (next == null || !next.startsWith("https://")) throw new IOException("Bad redirect from GitHub");
                url = next;
                continue;
            }
            if (code != 200) throw new IOException("GitHub answered " + code);
            break;
        }
        total = c.getContentLengthLong();
        try (InputStream in = c.getInputStream(); OutputStream o = new FileOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) {
                if (cancelled) return;
                o.write(buf, 0, n);
                sha.update(buf, 0, n);
                done += n;
            }
        } finally {
            c.disconnect();
        }
        StringBuilder got = new StringBuilder();
        for (byte b : sha.digest()) got.append(String.format("%02x", b));
        if (!got.toString().equals(want)) throw new IOException("The download did not match GitHub's checksum");
    }

    private void install(File apk) throws IOException {
        PackageInstaller pi = app.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(app.getPackageName());
        // Internal storage: on some TVs an update otherwise lands on adopted USB storage with empty data.
        params.setInstallLocation(PackageInfo.INSTALL_LOCATION_INTERNAL_ONLY);
        params.setSize(apk.length());
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream o = s.openWrite("vag11.apk", 0, apk.length())) {
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
                s.fsync(o);
            }
            String action = app.getPackageName() + ".UPDATE_STATUS." + id;
            BroadcastReceiver r = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                        Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                        if (confirm != null) {
                            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            state = "confirm";
                            activity.startActivity(confirm);
                        }
                        return;
                    }
                    try {
                        app.unregisterReceiver(this);
                    } catch (RuntimeException ignored) {
                    }
                    if (status == PackageInstaller.STATUS_SUCCESS) {
                        state = "idle";
                    } else {
                        String m = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                        message = status == PackageInstaller.STATUS_FAILURE_ABORTED ? "Not installed" : (m == null ? "Not installed" : m);
                        state = "error";
                    }
                }
            };
            IntentFilter filter = new IntentFilter(action);
            if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(r, filter, 4 /* RECEIVER_NOT_EXPORTED */);
            else app.registerReceiver(r, filter);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? 0x02000000 /* FLAG_MUTABLE */ : 0);
            PendingIntent sender = PendingIntent.getBroadcast(app, id, new Intent(action).setPackage(app.getPackageName()), flags);
            s.commit(sender.getIntentSender());
        }
    }
}
