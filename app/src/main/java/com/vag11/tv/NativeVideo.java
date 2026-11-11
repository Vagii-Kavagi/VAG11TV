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
import java.util.Arrays;
import java.util.Iterator;
import java.util.Map;
import java.util.TreeMap;

/**
 * Experimental: decodes the H.264 frames the page hands over (res/raw/native_video.js) onto a surface
 * that lies under the page, in step with the page's own clock. Sound stays in the page.
 *
 * The frames are kept the way a browser keeps a video buffer: by time, replaced when the player
 * appends the same stretch again in another quality, removed when the player removes them. That is
 * what makes a seek inside the buffered part work without the page sending anything again.
 */
final class NativeVideo implements SurfaceHolder.Callback, Runnable {
    private static final String TAG = WebShellActivity.TAG;
    private static final String MIME = "video/avc";
    /** A keyframe further back than this belongs to another buffered stretch. */
    private static final long MAX_KEYFRAME_DISTANCE_US = 12_000_000;

    interface Listener {
        /** First frame of a video is on the surface (true), or the video ended (false). */
        void onShowing(boolean showing);

        void onStats(long rendered, long dropped);

        /** The picture for the start (seek 0) or a seek is up: the page may let playback go on. */
        void onFirstPicture(int session, int seek);

        /** Where the page wants the picture, in page pixels. */
        void onRect(double x, double y, double w, double h, double pageW, double pageH);
    }

    /** H.264 frames can be decoded in another order than they are shown: both times are kept. */
    private static final class Frame {
        final byte[] data;
        final boolean key;
        final long ptsUs;

        Frame(byte[] data, boolean key, long ptsUs) {
            this.data = data;
            this.key = key;
            this.ptsUs = ptsUs;
        }
    }

    private final Object lock = new Object();
    /** By decode time, the order the decoder must get them in. */
    private final TreeMap<Long, Frame> store = new TreeMap<>();
    // The stream's parameter sets (SPS, PPS), with start codes. Guarded by lock.
    private byte[] csd0;
    private byte[] csd1;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Listener listener;
    private final Thread thread;

    // Guarded by lock.
    private Surface surface;
    private boolean quit;
    private boolean active;
    private boolean needSeek;
    private int session = -1;
    private int seekSeq;
    /** Decode time of the next frame the decoder will get. */
    private long fedUpTo = Long.MIN_VALUE;
    /**
     * Earliest decode time of new frames that arrived for a stretch the decoder had already been
     * given (a quality switch, or data fetched again after a seek). Feeding goes back to there.
     */
    private long rewindTo = Long.MAX_VALUE;
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
                    seekSeq = 0;
                    rewindTo = Long.MAX_VALUE;
                    store.clear();
                    csd0 = csd1 = null;
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
                } else if ("seek".equals(t)) {
                    // Also a small seek, which the clock alone would not count as one. The position
                    // comes with it, as the next clock report may come after.
                    seekSeq = m.optInt("seq");
                    clockPosUs = m.optDouble("pos", 0) * 1e6;
                    clockWallMs = System.currentTimeMillis();
                    running = false;
                    haveClock = true;
                    needSeek = true;
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
            return nowUsLocked();
        }
    }

    private long nowUsLocked() {
        if (!running) return (long) clockPosUs;
        return (long) (clockPosUs + (System.currentTimeMillis() - clockWallMs) * 1000.0 * rate);
    }

    /**
     * Binary messages from the page. Type 1: id, width, height, then the SPS and the PPS, each after
     * its length. Type 2: id, width, height, frame time, count, then per frame its display time,
     * decode time, keyframe flag, length and bytes.
     */
    void onFrames(byte[] bytes) {
        try {
            ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
            if (bytes.length < 17) return;
            int type = b.get(), id = b.getInt(), w = b.getInt(), h = b.getInt();
            synchronized (lock) {
                if (id != session) return;
                if (w > 0 && h > 0) {
                    width = w;
                    height = h;
                }
                if (type == 1) {
                    byte[] sps = new byte[b.getInt()];
                    b.get(sps);
                    byte[] pps = new byte[b.getInt()];
                    b.get(pps);
                    // The first ones set up the decoder; later ones travel ahead of each keyframe.
                    if (csd0 == null) {
                        csd0 = sps;
                        csd1 = pps;
                    }
                } else if (type == 2) {
                    long frameUs = Math.max(1000, Math.min(100_000, b.getInt()));
                    int count = b.getInt();
                    for (int i = 0; i < count && b.remaining() >= 21; i++) {
                        long pts = (long) (b.getDouble() * 1e6);
                        long dts = (long) (b.getDouble() * 1e6);
                        boolean key = b.get() != 0;
                        int len = b.getInt();
                        if (len < 0 || len > b.remaining()) break;
                        byte[] data = new byte[len];
                        b.get(data);
                        insert(dts, frameUs, new Frame(data, key, pts));
                    }
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
    private void insert(long dts, long frameUs, Frame f) {
        Map<Long, Frame> over = store.subMap(dts - 2000, dts + frameUs - 2000);
        // The same frame again (the player fetches data again after a seek): nothing changes.
        if (over.size() == 1) {
            Frame old = over.values().iterator().next();
            if (old.key == f.key && old.ptsUs == f.ptsUs && Arrays.equals(old.data, f.data)) return;
        }
        // Different data starting at a keyframe the decoder is already past (a change of quality):
        // the frames after it only make sense after that keyframe, so feeding goes back to it, once.
        // Frames already on screen are left alone.
        if (f.key && dts < fedUpTo && f.ptsUs > nowUsLocked() - 100_000) rewindTo = Math.min(rewindTo, dts);
        if (!over.isEmpty()) {
            over.clear();
            Iterator<Map.Entry<Long, Frame>> it = store.tailMap(dts, false).entrySet().iterator();
            while (it.hasNext() && !it.next().getValue().key) it.remove();
        }
        store.put(dts, f);
    }

    /** The first keyframe shown at or after {@code t}, within 10 s; null if there is none yet. */
    private Long keyframeAfter(long t) {
        for (Map.Entry<Long, Frame> e : store.tailMap(t - 200_000, true).entrySet()) {
            Frame f = e.getValue();
            if (f.ptsUs - t > 10_000_000) break;
            if (f.key && f.ptsUs >= t) return e.getKey();
        }
        return null;
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
        int shownSeq = 0;       // which seek the picture being prepared is for
        int lateInARow = 0;
        boolean showing = false;
        long lastStats = 0;

        while (true) {
            Surface s;
            boolean act, seek, run;
            int w, h, sess;
            byte[] c0, c1;
            synchronized (lock) {
                if (quit) break;
                s = surface;
                sess = session;
                act = active && haveClock && width > 0 && csd0 != null;
                c0 = csd0;
                c1 = csd1;
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
                    codec = start(s, w, h, c0, c1);
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
                        shownSeq = seekSeq;
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
                    synchronized (lock) {
                        fedUpTo = feedPos;
                        rewindTo = Long.MAX_VALUE;
                    }
                    dropBefore = target;
                    shownSinceSeek = false;
                }

                boolean fed = false;
                Map.Entry<Long, Frame> next;
                synchronized (lock) {
                    if (rewindTo < feedPos) {
                        // Back to the keyframe the new data starts from.
                        Frame k = store.get(rewindTo);
                        if (k != null && k.key) feedPos = rewindTo;
                    }
                    rewindTo = Long.MAX_VALUE;
                    next = store.ceilingEntry(feedPos);
                }
                if (next != null) {
                    int in = codec.dequeueInputBuffer(0);
                    if (in >= 0) {
                        ByteBuffer buf = codec.getInputBuffer(in);
                        Frame f = next.getValue();
                        int len = buf != null && buf.capacity() >= f.data.length ? f.data.length : 0;
                        if (len > 0) {
                            buf.clear();
                            buf.put(f.data);
                        }
                        // Fed in decode order, labelled with the display time the output comes back with.
                        codec.queueInputBuffer(in, 0, len, f.ptsUs,
                                f.key ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0);
                        feedPos = next.getKey() + 1;
                        fed = true;
                        synchronized (lock) {
                            fedUpTo = feedPos;
                        }
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
                        final int seq = shownSeq;
                        ui.post(() -> listener.onFirstPicture(sess, seq));
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
                        // Behind. A late frame still costs a decode, so at 1080p60 the decoder
                        // never catches up by dropping: go on from the next keyframe that is safely
                        // ahead instead, a short pause rather than a long run of late frames.
                        if (++lateInARow >= 6) {
                            Long k;
                            synchronized (lock) {
                                k = keyframeAfter(nowUsLocked() + 250_000);
                            }
                            if (k != null) {
                                codec.flush();
                                feedPos = k;
                                dropBefore = 0;
                                synchronized (lock) {
                                    fedUpTo = feedPos;
                                    rewindTo = Long.MAX_VALUE;
                                }
                                Log.i(TAG, "video behind: on from the keyframe at " + k / 1000 + " ms");
                            }
                            lateInARow = 0;
                        }
                    } else if (diff > 20_000) {
                        Thread.sleep(Math.min(10, (diff - 15_000) / 1000 + 1));
                    } else {
                        codec.releaseOutputBuffer(held, System.nanoTime() + Math.max(0, diff) * 1000);
                        held = -1;
                        rendered++;
                        lateInARow = 0;
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

    private static MediaCodec start(Surface s, int w, int h, byte[] sps, byte[] pps) throws Exception {
        MediaFormat f = MediaFormat.createVideoFormat(MIME, w, h);
        f.setByteBuffer("csd-0", ByteBuffer.wrap(sps));
        f.setByteBuffer("csd-1", ByteBuffer.wrap(pps));
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
