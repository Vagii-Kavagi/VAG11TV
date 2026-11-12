package com.vag11.tv.updater;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

import dev.cobalt.coat.CobaltService;

/**
 * The updater as a Cobalt platform service. The page sends one JSON request per message, {"cmd": ...}, and gets the
 * answer back as UTF-8 text: appInfo, canInstall ("true"/"false"), openInstallSetting, state, start (with "path"
 * and "sha256"), cancel.
 */
final class UpdaterService extends CobaltService {
    private final Vag11Updater updater;

    UpdaterService(Vag11Updater updater) {
        this.updater = updater;
    }

    @Override
    public ResponseToClient receiveFromClient(byte[] data) {
        String answer;
        try {
            JSONObject req = new JSONObject(new String(data, StandardCharsets.UTF_8));
            switch (req.optString("cmd")) {
                case "appInfo": answer = updater.appInfo(); break;
                case "canInstall": answer = String.valueOf(updater.canInstall()); break;
                case "openInstallSetting": updater.openInstallSetting(); answer = "ok"; break;
                case "state": answer = updater.state(); break;
                case "start": answer = updater.start(req.optString("path"), req.optString("sha256")); break;
                case "cancel": updater.cancel(); answer = "ok"; break;
                default: answer = "unknown command";
            }
        } catch (JSONException | RuntimeException e) {
            Log.w(FileProvider1.TAG, "updater request failed", e);
            answer = "error: " + e;
        }
        ResponseToClient r = new ResponseToClient();
        r.invalidState = false;
        r.data = answer.getBytes(StandardCharsets.UTF_8);
        return r;
    }

    @Override public void beforeStartOrResume() { }
    @Override public void beforeSuspend() { }
    @Override public void afterStopped() { }
    @Override public void close() { }
}
