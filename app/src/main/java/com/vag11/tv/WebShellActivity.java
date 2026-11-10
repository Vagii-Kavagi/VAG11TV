package com.vag11.tv;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A shell around YouTube's own TV interface (youtube.com/tv), opened signed out.
 *
 * The page is YouTube's. The additions are two entries in its Settings page
 * (res/raw/settings_hook.js): an ad blocker (res/raw/ad_block.js) and SponsorBlock
 * (res/raw/sb_engine.js).
 */
public class WebShellActivity extends Activity {
    static final String TAG = "VAG11TV";
    private static final String TV_URL = "https://www.youtube.com/tv";
    private static final String TV_ORIGIN = "https://www.youtube.com";
    // YouTube only serves the TV interface to a TV user agent.
    private static final String TV_UA =
            "Mozilla/5.0 (Linux; Android 9; MiTV-MSSP2) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 Cobalt/10.0";

    private WebView web;
    private Prefs prefs;
    private boolean scriptsAtDocumentStart;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = new Prefs(this);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(TV_UA);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.setBackgroundColor(Color.BLACK);
        web.addJavascriptInterface(new Bridge(), "VAG11");

        final String scripts = readRaw(R.raw.shell_hook) + "\n" + readRaw(R.raw.ad_block)
                + "\n" + readRaw(R.raw.player_tune) + "\n" + readRaw(R.raw.settings_hook)
                + "\n" + readRaw(R.raw.sb_engine);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, scripts, Collections.singleton(TV_ORIGIN));
            scriptsAtDocumentStart = true;
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                super.onPageStarted(v, url, favicon);
                // Older WebViews: the scripts guard against running twice.
                if (!scriptsAtDocumentStart && url != null && url.startsWith(TV_ORIGIN)) {
                    v.evaluateJavascript(scripts, null);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                return true;
            }

            // Until a video has its first frame, a WebView paints its stock placeholder over it: a
            // grey play button, stretched to the screen. An empty picture leaves YouTube's own
            // loading screen showing instead.
            @Override
            public Bitmap getDefaultVideoPoster() {
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
        });

        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(TV_URL);
        web.requestFocus();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        // The TV interface listens for Escape as "back"; Android's Back never reaches a page.
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK && web != null) {
            web.dispatchKeyEvent(new KeyEvent(e.getDownTime(), e.getEventTime(), e.getAction(),
                    KeyEvent.KEYCODE_ESCAPE, e.getRepeatCount()));
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web == null) return;
        web.onResume();
        // Coming back from one of the menus: hand the page the new choices.
        web.evaluateJavascript(
                "window.__vag11sb&&window.__vag11sb.setConfig(" + prefs.json() + ");"
                        + "window.__vag11ads&&window.__vag11ads.set(" + prefs.adBlock() + ");", null);
        web.requestFocus();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private String readRaw(int resId) {
        try (InputStream in = getResources().openRawResource(resId);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } catch (Exception e) {
            Log.e(TAG, "readRaw failed", e);
            return "";
        }
    }

    /**
     * Asks SponsorBlock for a video's segments. Only the first four characters of the SHA-256 of the
     * video id leave the TV, so the server cannot tell which video is being watched.
     */
    private JSONArray loadSegments(String videoId) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(videoId.getBytes("UTF-8"));
        String prefix = String.format("%02x%02x", hash[0], hash[1]);
        JSONArray cats = new JSONArray();
        for (String c : Prefs.CATS) cats.put(c);
        URL url = new URL("https://sponsor.ajay.app/api/skipSegments/" + prefix
                + "?categories=" + URLEncoder.encode(cats.toString(), "UTF-8"));

        JSONArray out = new JSONArray();
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        try {
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            if (c.getResponseCode() != 200) return out; // 404: nothing reported for this prefix
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) body.write(buf, 0, n);
            }
            JSONArray videos = new JSONArray(body.toString("UTF-8"));
            for (int i = 0; i < videos.length(); i++) {
                JSONObject v = videos.getJSONObject(i);
                if (!videoId.equals(v.optString("videoID"))) continue;
                JSONArray segs = v.optJSONArray("segments");
                for (int j = 0; segs != null && j < segs.length(); j++) {
                    JSONObject sgm = segs.getJSONObject(j);
                    JSONArray range = sgm.optJSONArray("segment");
                    if (range == null || range.length() != 2) continue;
                    if (!"skip".equals(sgm.optString("actionType", "skip"))) continue;
                    out.put(new JSONObject()
                            .put("cat", sgm.optString("category"))
                            .put("start", range.getDouble(0))
                            .put("end", range.getDouble(1))
                            .put("uuid", sgm.optString("UUID"))
                            .put("videoDuration", sgm.optDouble("videoDuration", 0)));
                }
            }
        } finally {
            c.disconnect();
        }
        return out;
    }

    public class Bridge {
        @JavascriptInterface
        public void log(String msg) {
            Log.i(TAG, "js: " + msg);
        }

        /** The page asked to close (res/raw/shell_hook.js). */
        @JavascriptInterface
        public void exit() {
            runOnUiThread(WebShellActivity.this::finish);
        }

        @JavascriptInterface
        public String getConfig() {
            return prefs.json();
        }

        @JavascriptInterface
        public void openSettings(final String page) {
            runOnUiThread(() -> startActivity(
                    new Intent(WebShellActivity.this, SettingsActivity.class)
                            .putExtra(SettingsActivity.EXTRA_PAGE, page)));
        }

        /** Answers through window.__vag11sb.onSegments(videoId, [...]). */
        @JavascriptInterface
        public void fetchSegments(final String videoId) {
            if (videoId == null || !videoId.matches("[A-Za-z0-9_-]{11}")) return;
            io.execute(() -> {
                String segs;
                try {
                    segs = loadSegments(videoId).toString();
                } catch (Exception e) {
                    Log.w(TAG, "segments failed: " + e);
                    segs = "[]";
                }
                final String js = "window.__vag11sb&&window.__vag11sb.onSegments('" + videoId + "',"
                        + segs + ");";
                runOnUiThread(() -> {
                    if (web != null) web.evaluateJavascript(js, null);
                });
            });
        }
    }
}
