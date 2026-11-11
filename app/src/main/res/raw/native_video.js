// Experimental: plays the picture on a native video surface under the page (NativeVideo.java).
//
// A WebView draws video into the same surface as the page, which on this kind of TV is 1280x720
// whatever the stream. A native surface is not limited that way. YouTube's player keeps doing all
// the work it normally does (choosing quality, downloading, the controls); only the last step
// changes:
//   - the video SourceBuffer the player asks for is replaced by a stand-in. What the player appends
//     to it (H.264 in MP4) is split into frames here and handed to the app, which decodes them;
//   - sound stays in the page. Its <video> element therefore plays audio only, and its clock
//     (currentTime) is what the app shows the frames against.
// Streams that are not H.264 are left to the page as before.
(function () {
    if (window.top !== window || window.__vag11nv) return;
    var bridge = window.VAG11;
    var wanted = false;
    try { wanted = !!(bridge && window.MediaSource && bridge.nativeVideo()); } catch (e) { }

    var nv = window.__vag11nv = {
        // The largest picture the TV's H.264 decoder accepts (media_codecs.xml on a MiTV-MSSP2). A
        // wider stream, such as a 2400x1080 ultra-wide one, is refused and leaves the screen blank.
        maxWidth: 1920, maxHeight: 1088,
        current: null, rendered: 0, dropped: 0, nextId: 1,
        on: function () { return wanted && !!window.VAG11V; },
        // Called by the app about once a second.
        stats: function (rendered, dropped) { nv.rendered = rendered; nv.dropped = dropped; }
    };
    if (!wanted) return;

    // YouTube's player offers no quality taller than the area it draws into, counted in device
    // pixels: on a 1280x720 WebView that stops at 720p. The picture is no longer drawn there, so
    // the page is told the pixels are dense enough for 1080p.
    var realRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    // For player_tune.js, whose limits are about the page's own surface.
    nv.realRatio = function () { return realRatio && realRatio.get ? realRatio.get.call(window) : 1; };
    try {
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true, enumerable: true,
            get: function () {
                var real = nv.realRatio();
                var h = window.innerHeight || 0;
                return h > 0 ? Math.max(real, 1080 / h) : real;
            }
        });
    } catch (e) { }

    // 60 frames a second. Before allowing any format above 32 fps, the player checks whether the
    // browser really reads the "framerate" part of a type: it asks once with 30 and once with an
    // absurd rate, and expects a no to the second. A WebView ignores the parameter and says yes to
    // both, so the player bans every 60 fps format ("capHfr"). TV engines answer as expected; so
    // does this. The TV's H.264 decoder manages 1080p at 60 (media_codecs.xml).
    var realIsTypeSupported = MediaSource.isTypeSupported;
    MediaSource.isTypeSupported = function (type) {
        var m = /framerate=([\d.]+)/.exec(type || '');
        if (m && +m[1] > 60) return false;
        return realIsTypeSupported.apply(this, arguments);
    };

    // And it is held there: the player starts low and steps down on its own, so while a video plays
    // it is asked again whenever it is below 1080p, or below the best a video without 1080p has.
    var lastAsk = 0;
    function hold1080() {
        var p = document.querySelector('.html5-video-player'), now = Date.now();
        if (!p || !p.setPlaybackQualityRange || !p.getAvailableQualityLevels || now - lastAsk < 3000) return;
        try {
            var levels = p.getAvailableQualityLevels().filter(function (l) { return l !== 'auto'; });
            if (!levels.length) return;
            var best = levels.indexOf('hd1080') >= 0 ? 'hd1080' : levels[0];
            if (p.getPlaybackQuality() === best) return;
            lastAsk = now;
            p.setPlaybackQualityRange(best, best);
        } catch (e) { }
    }

    function post(m) {
        try { window.VAG11V.postMessage(typeof m === 'string' || m instanceof ArrayBuffer ? m : JSON.stringify(m)); } catch (e) { }
    }

    // H.264 in fragmented MP4: an init segment (moov) says how the stream is coded, then each
    // fragment is a moof (the table of frames) followed by an mdat (the frames).
    function u32(d, o) { return d[o] * 16777216 + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3]; }
    function i32(d, o) { var v = u32(d, o); return v >= 2147483648 ? v - 4294967296 : v; }
    function boxSize(d, p, n) { // [size, header length], or null while the header is incomplete
        if (p + 8 > n) return null;
        var size = u32(d, p);
        if (size === 1) return p + 16 > n ? null : [u32(d, p + 8) * 4294967296 + u32(d, p + 12), 16];
        return [size === 0 ? n - p : size, 8];
    }
    // Calls cb(type, bodyStart, end) for each whole box in d[s, e).
    function boxes(d, s, e, cb) {
        while (s < e) {
            var b = boxSize(d, s, e);
            if (!b || b[0] < 8 || s + b[0] > e) return;
            cb(String.fromCharCode(d[s + 4], d[s + 5], d[s + 6], d[s + 7]), s + b[1], s + b[0]);
            s += b[0];
        }
    }
    // Parameter sets with start codes, the form the decoder takes.
    function annexB(list) {
        var n = 0, i, o = 0;
        for (i = 0; i < list.length; i++) n += 4 + list[i].length;
        var out = new Uint8Array(n);
        for (i = 0; i < list.length; i++) { out[o + 3] = 1; out.set(list[i], o + 4); o += 4 + list[i].length; }
        return out;
    }

    function Fake(type, id) {
        var self = this, target = document.createDocumentFragment();
        this.id = id; this.type = type; this.mode = 'segments'; this.updating = false;
        this.timestampOffset = 0; this.appendWindowStart = 0; this.appendWindowEnd = Infinity;
        this.ranges = []; this.pending = new Uint8Array(0);
        this.timescale = 0; this.trexDur = 0; this.trexSize = 0; this.lenSize = 4;
        this.sps = null; this.pps = null; this.configSent = false; this.width = 0; this.height = 0;
        this.frag = null; // the fragment whose frames are still arriving
        this.frameTime = 1 / 30; this.lastDts = -1; this.closed = false;
        this.addEventListener = function (t, f, o) { target.addEventListener(t, f, o); };
        this.removeEventListener = function (t, f, o) { target.removeEventListener(t, f, o); };
        this.dispatchEvent = function (ev) { return target.dispatchEvent(ev); };
        this.fire = function (t) {
            var ev = new Event(t);
            if (typeof self['on' + t] === 'function') { try { self['on' + t](ev); } catch (e) { } }
            target.dispatchEvent(ev);
        };
        Object.defineProperty(this, 'buffered', {
            get: function () {
                var r = self.ranges.slice();
                // Until the app's decoder has the first picture up (after a start or a seek), nothing
                // ahead of the playhead counts as buffered, so the player waits for it instead of
                // starting the sound while the decoder is still warming up.
                if (!nv.ready && nv.current === self) {
                    var v = document.querySelector('video'), at = v ? v.currentTime : 0;
                    r = r.map(function (x) { return [x[0], Math.min(x[1], at)]; })
                        .filter(function (x) { return x[1] > x[0]; });
                }
                return { length: r.length, start: function (i) { return r[i][0]; }, end: function (i) { return r[i][1]; } };
            }
        });
    }

    Fake.prototype.addRange = function (a, b) {
        var all = this.ranges.concat([[a, b]]).sort(function (x, y) { return x[0] - y[0]; }), out = [];
        all.forEach(function (x) {
            var last = out[out.length - 1];
            if (last && x[0] <= last[1] + 0.05) last[1] = Math.max(last[1], x[1]); else out.push([x[0], x[1]]);
        });
        this.ranges = out;
    };

    Fake.prototype.cutRange = function (a, b) {
        var out = [];
        this.ranges.forEach(function (r) {
            if (r[1] <= a || r[0] >= b) { out.push(r); return; }
            if (r[0] < a) out.push([r[0], a]);
            if (r[1] > b) out.push([b, r[1]]);
        });
        this.ranges = out;
    };

    // Reads every whole init segment, and hands on each frame as soon as its bytes have arrived:
    // once a fragment's table (moof) is in, its frames are known before the rest of it comes. At
    // 1080p a fragment can be a few seconds of video; waiting for all of it held up the start and
    // made frames late.
    Fake.prototype.parse = function () {
        var d = this.pending, n = d.length, p = 0, frames = [];
        for (; ;) {
            var fr = this.frag;
            if (fr) {
                while (fr.next < fr.samples.length && fr.samples[fr.next].end <= n) {
                    var x = fr.samples[fr.next++];
                    x.d = d;
                    frames.push(x);
                }
                if (fr.next < fr.samples.length || n < fr.end) break;
                p = fr.end;
                this.frag = null;
            }
            var b = boxSize(d, p, n);
            if (!b) break;
            if (b[0] < 8) { p = n; break; } // not MP4: drop it
            if (p + b[0] > n) break;
            var type = String.fromCharCode(d[p + 4], d[p + 5], d[p + 6], d[p + 7]);
            if (type === 'moov') {
                this.readInit(d, p + b[1], p + b[0]);
            } else if (type === 'moof') {
                var q = p + b[0], m = boxSize(d, q, n);
                if (!m) break;
                var samples = [];
                this.readFragment(d, p, p + b[1], p + b[0], samples);
                this.frag = { samples: samples, next: 0, end: q + m[0] };
                p = q; // the fragment's bytes are kept from here until its last frame is out
                continue;
            }
            p += b[0];
        }
        if (frames.length) this.send(frames);
        // Drop what is done with, and move the open fragment's offsets along with it.
        if (p > 0 && this.frag) {
            this.frag.end -= p;
            this.frag.samples.forEach(function (s) { s.start -= p; s.end -= p; });
        }
        this.pending = p >= n && !this.frag ? new Uint8Array(0) : d.slice(p);
    };

    Fake.prototype.readInit = function (d, s, e) {
        var self = this;
        boxes(d, s, e, function (t, s2, e2) {
            if (t === 'trak') boxes(d, s2, e2, function (t3, s3, e3) {
                if (t3 === 'mdia') boxes(d, s3, e3, function (t4, s4, e4) {
                    if (t4 === 'mdhd') self.timescale = d[s4] === 1 ? u32(d, s4 + 20) : u32(d, s4 + 12);
                    if (t4 === 'minf') boxes(d, s4, e4, function (t5, s5, e5) {
                        if (t5 === 'stbl') boxes(d, s5, e5, function (t6, s6, e6) {
                            if (t6 === 'stsd') self.readEntry(d, s6 + 8, e6);
                        });
                    });
                });
            });
            if (t === 'mvex') boxes(d, s2, e2, function (t3, s3) {
                if (t3 === 'trex') { self.trexDur = u32(d, s3 + 12); self.trexSize = u32(d, s3 + 16); }
            });
        });
    };

    // The avc1 sample entry: the picture size, then avcC with the parameter sets.
    Fake.prototype.readEntry = function (d, s, e) {
        var self = this;
        boxes(d, s, e, function (t, b, end) {
            if (t !== 'avc1' && t !== 'avc3') return;
            self.width = (d[b + 24] << 8) | d[b + 25];
            self.height = (d[b + 26] << 8) | d[b + 27];
            boxes(d, b + 78, end, function (t2, c) {
                if (t2 !== 'avcC') return;
                self.lenSize = (d[c + 4] & 3) + 1;
                var o = c + 5, sps = [], pps = [], i, len, count = d[o++] & 31;
                for (i = 0; i < count; i++) { len = (d[o] << 8) | d[o + 1]; sps.push(d.slice(o + 2, o + 2 + len)); o += 2 + len; }
                count = d[o++];
                for (i = 0; i < count; i++) { len = (d[o] << 8) | d[o + 1]; pps.push(d.slice(o + 2, o + 2 + len)); o += 2 + len; }
                self.sps = annexB(sps);
                self.pps = annexB(pps);
                self.configSent = false;
            });
        });
    };

    Fake.prototype.readFragment = function (d, moof, body, end, frames) {
        var self = this;
        boxes(d, body, end, function (t, s, e) {
            if (t !== 'traf') return;
            var dur0 = self.trexDur, size0 = self.trexSize, dts = 0, runs = [];
            boxes(d, s, e, function (t2, b) {
                var fl = u32(d, b) & 0xffffff, o = b + 8;
                if (t2 === 'tfhd') {
                    if (fl & 1) o += 8; // offsets here count from the moof (default-base-is-moof)
                    if (fl & 2) o += 4;
                    if (fl & 8) { dur0 = u32(d, o); o += 4; }
                    if (fl & 0x10) size0 = u32(d, o);
                } else if (t2 === 'tfdt') {
                    dts = d[b] === 1 ? u32(d, b + 4) * 4294967296 + u32(d, b + 8) : u32(d, b + 4);
                } else if (t2 === 'trun') {
                    runs.push(b);
                }
            });
            var off = moof;
            runs.forEach(function (b) {
                var ver = d[b], fl = u32(d, b) & 0xffffff, count = u32(d, b + 4), o = b + 8;
                if (fl & 1) { off = moof + i32(d, o); o += 4; }
                if (fl & 4) o += 4;
                for (var i = 0; i < count; i++) {
                    var dur = dur0, size = size0, cto = 0;
                    if (fl & 0x100) { dur = u32(d, o); o += 4; }
                    if (fl & 0x200) { size = u32(d, o); o += 4; }
                    if (fl & 0x400) o += 4;
                    if (fl & 0x800) { cto = ver === 1 ? i32(d, o) : u32(d, o); o += 4; }
                    frames.push({ dts: dts, pts: dts + cto, start: off, end: off + size });
                    off += size;
                    dts += dur;
                }
            });
        });
    };

    // One frame in the decoder's form: each NAL unit after a start code instead of its length, and
    // the parameter sets ahead of every keyframe, so a change of quality needs no new decoder.
    Fake.prototype.frameBytes = function (f) {
        var d = f.d, p = f.start, L = this.lenSize, nals = [], key = false, total = 0;
        while (p + L <= f.end) {
            var len = 0;
            for (var i = 0; i < L; i++) len = len * 256 + d[p + i];
            p += L;
            if (len <= 0 || p + len > f.end) break;
            if ((d[p] & 0x1f) === 5) key = true;
            nals.push([p, len]);
            total += 4 + len;
            p += len;
        }
        var head = key ? this.sps.length + this.pps.length : 0;
        var out = new Uint8Array(head + total), o = 0;
        if (key) { out.set(this.sps, 0); out.set(this.pps, this.sps.length); o = head; }
        nals.forEach(function (x) { out[o + 3] = 1; out.set(d.subarray(x[0], x[0] + x[1]), o + 4); o += 4 + x[1]; });
        return { key: key, bytes: out };
    };

    // Messages: type 1 carries the parameter sets; type 2 a batch of frames, each with its display
    // time, decode time, keyframe flag, length and bytes.
    Fake.prototype.send = function (frames) {
        if (!this.timescale || !this.sps) return;
        var ts = this.timescale, off = this.timestampOffset, i;
        if (!this.configSent) {
            var cfg = new ArrayBuffer(21 + this.sps.length + this.pps.length), cv = new DataView(cfg), cb = new Uint8Array(cfg);
            cv.setUint8(0, 1);
            cv.setUint32(1, this.id, true);
            cv.setUint32(5, this.width, true);
            cv.setUint32(9, this.height, true);
            cv.setUint32(13, this.sps.length, true);
            cb.set(this.sps, 17);
            cv.setUint32(17 + this.sps.length, this.pps.length, true);
            cb.set(this.pps, 21 + this.sps.length);
            post(cfg);
            this.configSent = true;
        }
        var conv = [], total = 21, lo = Infinity, hi = -Infinity;
        for (i = 0; i < frames.length; i++) {
            var f = frames[i], c = this.frameBytes(f);
            c.pts = f.pts / ts + off;
            c.dts = f.dts / ts + off;
            var gap = c.dts - this.lastDts;
            if (this.lastDts >= 0 && gap > 0.001 && gap < 0.2) this.frameTime = gap;
            this.lastDts = c.dts;
            lo = Math.min(lo, c.pts);
            hi = Math.max(hi, c.pts);
            conv.push(c);
            total += 21 + c.bytes.length;
        }
        var buf = new ArrayBuffer(total), view = new DataView(buf), out = new Uint8Array(buf), o = 21;
        view.setUint8(0, 2);
        view.setUint32(1, this.id, true);
        view.setUint32(5, this.width, true);
        view.setUint32(9, this.height, true);
        view.setUint32(13, Math.round(this.frameTime * 1e6), true);
        view.setUint32(17, conv.length, true);
        for (i = 0; i < conv.length; i++) {
            var x = conv[i];
            view.setFloat64(o, x.pts, true);
            view.setFloat64(o + 8, x.dts, true);
            view.setUint8(o + 16, x.key ? 1 : 0);
            view.setUint32(o + 17, x.bytes.length, true);
            out.set(x.bytes, o + 21);
            o += 21 + x.bytes.length;
        }
        post(buf);
        // H.264 frames are shown a frame or two after they are decoded, so a video's first frame
        // is at about 0.04 s. A browser counts that as buffered from 0; the player stalls on the
        // gap otherwise.
        if (lo > 0 && lo < 0.25) lo = 0;
        this.addRange(lo, hi + this.frameTime);
    };

    Fake.prototype.finish = function () {
        var self = this;
        this.updating = true;
        this.fire('updatestart');
        setTimeout(function () {
            self.updating = false;
            self.fire('update');
            self.fire('updateend');
        }, 0);
    };

    Fake.prototype.appendBuffer = function (data) {
        if (this.updating || this.closed) throw new DOMException('The SourceBuffer is busy or removed.', 'InvalidStateError');
        var u = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        var merged = new Uint8Array(this.pending.length + u.length);
        merged.set(this.pending);
        merged.set(u, this.pending.length);
        this.pending = merged;
        try { this.parse(); } catch (e) { this.pending = new Uint8Array(0); }
        this.finish();
    };

    Fake.prototype.remove = function (a, b) {
        if (this.updating || this.closed) throw new DOMException('The SourceBuffer is busy or removed.', 'InvalidStateError');
        this.cutRange(a, b);
        post({ t: 'remove', id: this.id, a: a, b: b === Infinity ? 1e9 : b });
        this.finish();
    };

    Fake.prototype.abort = function () { this.pending = new Uint8Array(0); this.frag = null; this.lastDts = -1; };
    Fake.prototype.changeType = function (type) { this.type = type; };

    // The picture is under the page, so while it plays the page must not paint over it. YouTube
    // paints black in two places there: the body and its player element (ytlr-player). Other
    // screens keep their black.
    var SEE_THROUGH = 'vag11-native-video';
    var seeThroughStyle = document.createElement('style');
    seeThroughStyle.textContent = 'html.' + SEE_THROUGH + ',html.' + SEE_THROUGH + ' body,html.'
        + SEE_THROUGH + ' ytlr-player{background:transparent!important}';
    function seeThrough(on) {
        var root = document.documentElement;
        if (!root) return;
        if (on && !seeThroughStyle.parentNode) (document.head || root).appendChild(seeThroughStyle);
        root.classList.toggle(SEE_THROUGH, on);
    }

    // Holding playback for the decoder: set on a start or a seek, cleared when the app reports the
    // first picture for the latest of them (nv.shown), and after 5 s in any case so playback can
    // never stick on it. Decoding from a keyframe up to a seek target can take seconds at 60 fps.
    var holdTimer = 0, seekSeq = 0;
    nv.ready = true;
    function release() {
        nv.ready = true;
        clearTimeout(holdTimer);
    }
    function hold() {
        nv.ready = false;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(release, 5000);
    }
    nv.shown = function (id, seq) {
        if (nv.current && nv.current.id === id && seq === seekSeq) release();
    };

    function close(fake) {
        fake.closed = true;
        release();
        if (nv.current !== fake) return;
        nv.current = null;
        seeThrough(false);
        post({ t: 'stop', id: fake.id });
    }

    var realAdd = MediaSource.prototype.addSourceBuffer, realRemove = MediaSource.prototype.removeSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (type) {
        if (!nv.on() || !/^video\/mp4/.test(type) || !/avc[13]/.test(type)) {
            return realAdd.apply(this, arguments);
        }
        var fake = new Fake(type, nv.nextId++);
        if (nv.current) nv.current.closed = true;
        nv.current = fake;
        seeThrough(true);
        post({ t: 'open', id: fake.id });
        seekSeq = 0;
        hold();
        this.addEventListener('sourceclose', function () { close(fake); });
        startClock();
        lastAsk = 0;
        return fake;
    };
    MediaSource.prototype.removeSourceBuffer = function (sb) {
        if (sb instanceof Fake) { close(sb); return; }
        return realRemove.apply(this, arguments);
    };

    // The page's clock, and where on the screen the picture belongs.
    var clockVideo = null, clockTimer = 0, ticks = 0;
    function tick() {
        var fake = nv.current;
        if (!fake) return;
        var v = document.querySelector('video');
        if (!v) return;
        if (++ticks % 4 === 0) hold1080();
        if (v !== clockVideo) {
            clockVideo = v;
            ['play', 'pause', 'playing', 'waiting', 'seeking', 'seeked', 'ratechange', 'ended'].forEach(function (n) {
                v.addEventListener(n, tick);
            });
            // A seek: the decoder starts again from a keyframe, and playback waits for it. The new
            // position travels with it: the next clock report may come after.
            v.addEventListener('seeking', function () {
                if (!nv.current) return;
                hold();
                post({ t: 'seek', id: nv.current.id, pos: v.currentTime, seq: ++seekSeq });
            }, true);
        }
        var r = v.getBoundingClientRect();
        post({
            t: 'clock', id: fake.id, pos: v.currentTime, wall: Date.now(), rate: v.playbackRate || 1,
            run: !v.paused && !v.seeking && !v.ended && v.readyState >= 3,
            x: r.left, y: r.top, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight
        });
    }
    function startClock() { if (!clockTimer) clockTimer = setInterval(tick, 250); }

    // The page's player reads the picture size and frame counts from the element.
    function fakeSize(name, field) {
        var d = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, name);
        if (!d || !d.get) return;
        Object.defineProperty(HTMLVideoElement.prototype, name, {
            configurable: true, enumerable: d.enumerable,
            get: function () { return d.get.call(this) || (nv.current ? nv.current[field] : 0); }
        });
    }
    fakeSize('videoWidth', 'width');
    fakeSize('videoHeight', 'height');
    var realQuality = HTMLVideoElement.prototype.getVideoPlaybackQuality;
    HTMLVideoElement.prototype.getVideoPlaybackQuality = function () {
        if (!nv.current) return realQuality.apply(this, arguments);
        return {
            creationTime: performance.now(), totalVideoFrames: nv.rendered + nv.dropped,
            droppedVideoFrames: nv.dropped, corruptedVideoFrames: 0
        };
    };
})();
