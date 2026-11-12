package com.vag11.tv.updater;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.lang.reflect.Method;

import dev.cobalt.coat.CobaltService;
import dev.cobalt.coat.StarboardBridge;

/**
 * The engine's FileProvider, renamed in the manifest to this subclass (same length, so the binary manifest only
 * changes in place). It still is that FileProvider; it also runs when the app starts, which is when VAG11's own
 * code can join the engine: once the engine's StarboardBridge exists, the updater is registered with it as the
 * Cobalt platform service "com.vag11.tv.updater", which the page opens through H5vccPlatformService.
 */
public class FileProvider1 extends androidx.core.content.FileProvider {
    static final String TAG = "VAG11";
    static final String SERVICE = "com.vag11.tv.updater";

    @Override
    public boolean onCreate() {
        boolean ok = super.onCreate();
        try {
            Context app = getContext().getApplicationContext();
            ((Application) app).registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
                @Override public void onActivityCreated(Activity a, Bundle b) { join(a, 0); }
                @Override public void onActivityStarted(Activity a) { }
                @Override public void onActivityResumed(Activity a) { }
                @Override public void onActivityPaused(Activity a) { }
                @Override public void onActivityStopped(Activity a) { }
                @Override public void onActivitySaveInstanceState(Activity a, Bundle b) { }
                @Override public void onActivityDestroyed(Activity a) { }
            });
        } catch (RuntimeException e) {
            Log.w(TAG, "updater not started", e);
        }
        return ok;
    }

    /** Registers the service with the activity's StarboardBridge, waiting for the engine to make it. */
    static void join(final Activity a, final int attempt) {
        StarboardBridge bridge = null;
        try {
            Method m = findMethod(a.getClass(), "getStarboardBridge");
            if (m == null) {
                if (attempt == 0) Log.w(TAG, "no getStarboardBridge on " + a.getClass().getName());
                return;
            }
            m.setAccessible(true);
            bridge = (StarboardBridge) m.invoke(a);
        } catch (ReflectiveOperationException | RuntimeException e) {
            Log.w(TAG, "StarboardBridge not reached", e);
        }
        if (bridge == null) {
            if (attempt < 60) {
                new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                    @Override public void run() { join(a, attempt + 1); }
                }, 250);
            } else {
                Log.w(TAG, "the engine never made its StarboardBridge; no updater");
            }
            return;
        }
        final Vag11Updater updater = new Vag11Updater(a);
        try {
            bridge.registerCobaltService(new CobaltService.Factory() {
                @Override public CobaltService createCobaltService(long nativeService) { return new UpdaterService(updater); }
                @Override public String getServiceName() { return SERVICE; }
            });
            Log.i(TAG, "updater registered as " + SERVICE);
        } catch (RuntimeException e) {
            Log.w(TAG, "updater not registered", e);
        }
    }

    private static Method findMethod(Class<?> c, String name) {
        for (; c != null; c = c.getSuperclass()) {
            for (Method m : c.getDeclaredMethods()) {
                if (m.getName().equals(name) && m.getParameterTypes().length == 0) return m;
            }
        }
        return null;
    }
}
