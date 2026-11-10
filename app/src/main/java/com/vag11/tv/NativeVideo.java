package com.vag11.tv;

import android.media.MediaCodec;
import android.media.MediaFormat;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Surface;
import android.view.SurfaceHolder;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Iterator;
import java.util.Map;
import java.util.TreeMap;

/**
 * Experimental: decodes the VP9 frames the page hands over (res/raw/native_video.js) onto a surface
 * that lies under the page, in step with the page's own clock. Sound stays in the page.
 *
 * The frames are kept the way a browser keeps a video buffer: by time, replaced when the player
 * appends the same stretch again in another quality, removed when the player removes them. That is
 * what makes a seek inside the buffered part work without the page sending anything again.
 */
final class NativeVideo implements SurfaceHolder.Callback, Runnable {
    private static final String TAG = WebShellActivity.TAG;
    private static final String MIME = "video/x-vnd.on2.vp9";
    /** A keyframe further back than this belongs to another buffered stretch. */
    private static final long MAX_KEYFRAME_DISTANCE_US = 12_000_000;

    interface Listener {
        /** First frame of a video is on the surface (true), or the video ended (false). */
        void onShowing(boolean showing);

        void onStats(long rendered, long dropped);

        /** Where the page wants the picture, in page pixels. */
        void onRect(double x, double y, double w, double h, double pageW, double pageH);
    }

    private static final class Frame {
        final byte[] data;
        final boolean key;

        Frame(byte[] data, boolean key) {
            this.data = data;
            this.key = key;
        }
    }

    private final Object lock = new Object();
    private final TreeMap<Long, Frame> store = new TreeMap<>();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Listener listener;
    private final Thread thread;

    // Guarded by lock.
    private Surface surface;
    private boolean quit;
    private boolean active;
    private boolean needSeek;
    private int session = -1;
    private int width;
    private int height;
    private boolean haveClock;
    private boolean running;
    private double clockPosUs;
    private long clockWallMs;
    private double rate = 1;

    private volatile long rendered;
    private volatile long dropped;
    private String lastRect = "";

    NativeVideo(Listener listener) {
        this.listener = listener;
        thread = new Thread(this, "vag11-video");
        thread.start();
    }

    void release() {
        synchronized (lock) {
            quit = true;
            lock.notifyAll();
        }
    }

    // ---- surface -------------------------------------------------------------------------------

    @Override
    public void surfaceCreated(SurfaceHolder h) {
        synchronized (lock) {
            surface = h.getSurface();
            needSeek = true;
            lock.notifyAll();
        }
    }

    @Override
    public void surfaceChanged(SurfaceHolder h, int format, int w, int ht) {
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder h) {
        synchronized (lock) {
            surface = null;
            lock.notifyAll();
        }
        // The decoder must let go of the surface before this returns.
        long until = System.currentTimeMillis() + 1000;
        synchronized (lock) {
            while (codecAlive && System.currentTimeMillis() < until) {
                try {
                    lock.wait(50);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }
    }

    // ---- messages from the page (main thread) --------------------------------------------------

    void onText(String text) {
        try {
            JSONObject m = new JSONObject(text);
            String t = m.optString("t");
            int id = m.optInt("id", -1);
            synchronized (lock) {
                if ("open".equals(t)) {
                    session = id;
                    store.clear();
                    active = true;
                    haveClock = false;
                    running = false;
                    needSeek = true;
                    lock.notifyAll();
                } else if (id != session) {
                    return;
                } else if ("stop".equals(t)) {
                    active = false;
                    store.clear();
                    lock.notifyAll();
                } else if ("remove".equals(t)) {
                    long a = (long) (m.optDouble("a", 0) * 1e6), b = (long) (m.optDouble("b", 0) * 1e6);
                    if (b > a) store.subMap(a, b).clear();
                } else if ("clock".equals(t)) {
                    clock(m.optDouble("pos", 0) * 1e6, m.optLong("wall"), m.optDouble("rate", 1),
                            m.optBoolean("run"));
                }
            }
            if ("stop".equals(t)) listener.onShowing(false);
            if ("open".equals(t)) listener.onShowing(false);
            if ("clock".equals(t)) {
                String rect = m.optString("x") + m.optString("y") + m.optString("w") + m.optString("h");
                if (!rect.equals(lastRect)) {
                    lastRect = rect;
                    listener.onRect(m.optDouble("x"), m.optDouble("y"), m.optDouble("w"), m.optDouble("h"),
                            m.optDouble("vw"), m.optDouble("vh"));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "video message: " + e);
        }
    }

    /** Small differences are eased out, so the picture does not jerk at each report. */
    private void clock(double posUs, long wallMs, double newRate, boolean run) {
        double predicted = !haveClock ? posUs
                : running ? clockPosUs + (wallMs - clockWallMs) * 1000.0 * rate : clockPosUs;
        double err = posUs - predicted;
        // A jump is a seek: decoding starts again from the keyframe before the new position.
        if (!haveClock || Math.abs(err) > 400_000) needSeek = true;
        if (haveClock && run == running && newRate == rate && Math.abs(err) < 80_000) {
            clockPosUs = predicted + err * 0.15;
            clockWallMs = wallMs;
            return;
        }
        haveClock = true;
        running = run;
        rate = newRate;
        clockPosUs = posUs;
        clockWallMs = wallMs;
        lock.notifyAll();
    }

    private long nowUs() {
        synchronized (lock) {
            if (!running) return (long) clockPosUs;
            return (long) (clockPosUs + (System.currentTimeMillis() - clockWallMs) * 1000.0 * rate);
        }
    }

    /** One append: header (type, id, width, height, frame time, count), then the frames. */
    void onFrames(byte[] bytes) {
        try {
            ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
            if (bytes.length < 21 || b.get() != 2) return;
            int id = b.getInt(), w = b.getInt(), h = b.getInt();
            long frameUs = Math.max(1000, Math.min(100_000, b.getInt()));
            int count = b.getInt();
            synchronized (lock) {
                if (id != session) return;
                if (w > 0 && h > 0) {
                    width = w;
                    height = h;
                }
                for (int i = 0; i < count && b.remaining() >= 13; i++) {
                    long pts = (long) (b.getDouble() * 1e6);
                    boolean key = b.get() != 0;
                    int len = b.getInt();
                    if (len < 0 || len > b.remaining()) break;
                    byte[] data = new byte[len];
                    b.get(data);
                    insert(pts, frameUs, new Frame(data, key));
                }
                lock.notifyAll();
            }
        } catch (Exception e) {
            Log.w(TAG, "video frames: " + e);
        }
    }

    /**
     * A new frame replaces what was at its time, and with that the old frames that depended on the
     * replaced one (everything up to the next old keyframe), as a browser's buffer does.
     */
    private void insert(long pts, long frameUs, Frame f) {
        Map<Long, Frame> over = store.subMap(pts - 2000, pts + frameUs - 2000);
        if (!over.isEmpty()) {
            over.clear();
            Iterator<Map.Entry<Long, Frame>> it = store.tailMap(pts, false).entrySet().iterator();
            while (it.hasNext() && !it.next().getValue().key) it.remove();
        }
        store.put(pts, f);
    }

    /** The keyframe to start decoding from to show {@code target}; null while it has not arrived. */
    private Long keyframeFor(long target) {
        for (Map.Entry<Long, Frame> e : store.headMap(target, true).descendingMap().entrySet()) {
            if (target - e.getKey() > MAX_KEYFRAME_DISTANCE_US) break;
            if (e.getValue().key) return e.getKey();
        }
        for (Map.Entry<Long, Frame> e : store.tailMap(target, false).entrySet()) {
            if (e.getKey() - target > 2_000_000) break;
            if (e.getValue().key) return e.getKey();
        }
        return null;
    }

    // ---- decoder thread ------------------------------------------------------------------------

    private boolean codecAlive; // guarded by lock

    @Override
    public void run() {
        MediaCodec codec = null;
        Surface codecSurface = null;
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        int held = -1;          // decoded frame waiting for its time
        long heldPts = 0;
        long feedPos = 0;       // time of the next frame to hand to the decoder
        long dropBefore = 0;    // frames before the seek target are decoded but not shown
        boolean shownSinceSeek = false;
        boolean showing = false;
        long lastStats = 0;

        while (true) {
            Surface s;
            boolean act, seek, run;
            int w, h;
            synchronized (lock) {
                if (quit) break;
                s = surface;
                act = active && haveClock && width > 0;
                w = width;
                h = height;
                run = running;
                if (s == null || !act) {
                    if (codec != null) {
                        stop(codec);
                        codec = null;
                        held = -1;
                        codecAlive = false;
                        lock.notifyAll();
                    }
                    showing = false;
                    try {
                        lock.wait(500);
                    } catch (InterruptedException e) {
                        break;
                    }
                    continue;
                }
                seek = needSeek;
                needSeek = false;
            }

            try {
                if (codec == null || codecSurface != s) {
                    if (codec != null) stop(codec);
                    codec = start(s, w, h);
                    codecSurface = s;
                    held = -1;
                    seek = true;
                    synchronized (lock) {
                        codecAlive = true;
                    }
                }

                if (seek) {
                    long target = nowUs();
                    Long key;
                    synchronized (lock) {
                        key = keyframeFor(target);
                        if (key == null) {
                            needSeek = true;
                            lock.wait(40);
                            continue;
                        }
                    }
                    held = -1;
                    codec.flush();
                    feedPos = key;
                    dropBefore = target;
                    shownSinceSeek = false;
                }

                boolean fed = false;
                Map.Entry<Long, Frame> next;
                synchronized (lock) {
                    next = store.ceilingEntry(feedPos);
                }
                if (next != null) {
                    int in = codec.dequeueInputBuffer(0);
                    if (in >= 0) {
                        ByteBuffer buf = codec.getInputBuffer(in);
                        byte[] data = next.getValue().data;
                        int len = buf != null && buf.capacity() >= data.length ? data.length : 0;
                        if (len > 0) {
                            buf.clear();
                            buf.put(data);
                        }
                        codec.queueInputBuffer(in, 0, len, next.getKey(), 0);
                        feedPos = next.getKey() + 1;
                        fed = true;
                    }
                }

                if (held < 0) {
                    int out = codec.dequeueOutputBuffer(info, fed ? 0 : 5000);
                    if (out >= 0) {
                        held = out;
                        heldPts = info.presentationTimeUs;
                    }
                }
                if (held >= 0) {
                    long diff = heldPts - nowUs();
                    if (heldPts < dropBefore) {
                        codec.releaseOutputBuffer(held, false);
                        held = -1;
                    } else if (!shownSinceSeek) {
                        // The frame at the seek target goes up at once, also while paused.
                        codec.releaseOutputBuffer(held, true);
                        held = -1;
                        shownSinceSeek = true;
                        rendered++;
                        if (!showing) {
                            showing = true;
                            ui.post(() -> listener.onShowing(true));
                        }
                    } else if (!run) {
                        Thread.sleep(10);
                    } else if (diff < -50_000) {
                        codec.releaseOutputBuffer(held, false);
                        held = -1;
                        dropped++;
                    } else if (diff > 20_000) {
                        Thread.sleep(Math.min(10, (diff - 15_000) / 1000 + 1));
                    } else {
                        codec.releaseOutputBuffer(held, System.nanoTime() + Math.max(0, diff) * 1000);
                        held = -1;
                        rendered++;
                    }
                }

                long now = System.currentTimeMillis();
                if (now - lastStats > 1000) {
                    lastStats = now;
                    final long r = rendered, d = dropped;
                    ui.post(() -> listener.onStats(r, d));
                }
            } catch (InterruptedException e) {
                break;
            } catch (Exception e) {
                // A decoder error: start over from a keyframe.
                Log.w(TAG, "video decoder: " + e);
                if (codec != null) stop(codec);
                codec = null;
                held = -1;
                synchronized (lock) {
                    codecAlive = false;
                    needSeek = true;
                    try {
                        lock.wait(300);
                    } catch (InterruptedException ie) {
                        break;
                    }
                }
            }
        }
        if (codec != null) stop(codec);
        synchronized (lock) {
            codecAlive = false;
            lock.notifyAll();
        }
    }

    private static MediaCodec start(Surface s, int w, int h) throws Exception {
        MediaFormat f = MediaFormat.createVideoFormat(MIME, w, h);
        // The player changes quality mid-stream; the decoder is told the largest it may see.
        f.setInteger(MediaFormat.KEY_MAX_WIDTH, 1920);
        f.setInteger(MediaFormat.KEY_MAX_HEIGHT, 1088);
        f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 2 * 1024 * 1024);
        MediaCodec c = MediaCodec.createDecoderByType(MIME);
        c.configure(f, s, null, 0);
        c.setVideoScalingMode(MediaCodec.VIDEO_SCALING_MODE_SCALE_TO_FIT);
        c.start();
        Log.i(TAG, "video decoder " + c.getName() + " " + w + "x" + h);
        return c;
    }

    private static void stop(MediaCodec c) {
        try {
            c.stop();
        } catch (Exception ignored) {
        }
        try {
            c.release();
        } catch (Exception ignored) {
        }
    }
}
