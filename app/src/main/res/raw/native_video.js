// Experimental: plays the picture on a native video surface under the page (NativeVideo.java).
//
// A WebView draws video into the same surface as the page, which on this kind of TV is 1280x720
// whatever the stream. A native surface is not limited that way. YouTube's player keeps doing all
// the work it normally does (choosing quality, downloading, the controls); only the last step
// changes:
//   - the video SourceBuffer the player asks for is replaced by a stand-in. What the player appends
//     to it (WebM with VP9) is split into frames here and handed to the app, which decodes them;
//   - sound stays in the page. Its <video> element therefore plays audio only, and its clock
//     (currentTime) is what the app shows the frames against.
// Streams that are not VP9 in WebM are left to the page as before.
(function () {
    if (window.top !== window || window.__vag11nv) return;
    var bridge = window.VAG11;
    var wanted = false;
    try { wanted = !!(bridge && window.MediaSource && bridge.nativeVideo()); } catch (e) { }

    var nv = window.__vag11nv = {
        maxHeight: 1080, current: null, rendered: 0, dropped: 0, nextId: 1,
        on: function () { return wanted && !!window.VAG11V; },
        // Called by the app about once a second.
        stats: function (rendered, dropped) { nv.rendered = rendered; nv.dropped = dropped; }
    };
    if (!wanted) return;

    function post(m) {
        try { window.VAG11V.postMessage(typeof m === 'string' || m instanceof ArrayBuffer ? m : JSON.stringify(m)); } catch (e) { }
    }

    // WebM element ids. Containers are walked into; everything else is read whole or skipped.
    var EBML = 0x1A45DFA3, TIMECODE_SCALE = 0x2AD7B1, WIDTH = 0xB0, HEIGHT = 0xBA,
        CLUSTER_TIME = 0xE7, SIMPLE_BLOCK = 0xA3, BLOCK = 0xA1;
    var CONTAINERS = {};
    [0x18538067 /* Segment */, 0x1549A966 /* Info */, 0x1654AE6B /* Tracks */, 0xAE /* TrackEntry */,
        0xE0 /* Video */, 0x1F43B675 /* Cluster */, 0xA0 /* BlockGroup */].forEach(function (id) { CONTAINERS[id] = true; });

    function uint(d, s, e) { var v = 0; for (var i = s; i < e; i++) v = v * 256 + d[i]; return v; }

    function Fake(type, id) {
        var self = this, target = document.createDocumentFragment();
        this.id = id; this.type = type; this.mode = 'segments'; this.updating = false;
        this.timestampOffset = 0; this.appendWindowStart = 0; this.appendWindowEnd = Infinity;
        this.ranges = []; this.pending = new Uint8Array(0);
        this.scale = 1000000; this.clusterTime = 0; this.width = 0; this.height = 0;
        this.frameTime = 1 / 30; this.lastPts = -1; this.closed = false;
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

    // Reads as many whole elements as have arrived; the rest waits for the next append.
    Fake.prototype.parse = function () {
        var d = this.pending, n = d.length, p = 0, frames = [], i;
        for (; ;) {
            if (p + 2 > n) break;
            var b = d[p], idLen = b & 0x80 ? 1 : b & 0x40 ? 2 : b & 0x20 ? 3 : b & 0x10 ? 4 : 0;
            if (!idLen) { p = n; break; } // not WebM: drop it
            if (p + idLen + 1 > n) break;
            var id = uint(d, p, p + idLen);
            var sb = d[p + idLen], sizeLen = 1, mark = 0x80;
            while (sizeLen <= 8 && !(sb & mark)) { sizeLen++; mark >>= 1; }
            if (sizeLen > 8) { p = n; break; }
            var body = p + idLen + sizeLen;
            if (body > n) break;
            if (CONTAINERS[id]) { p = body; continue; }
            var size = sb & (mark - 1), unknown = size === mark - 1;
            for (i = 1; i < sizeLen; i++) { var x = d[p + idLen + i]; size = size * 256 + x; if (x !== 255) unknown = false; }
            if (unknown) { p = n; break; }
            var end = body + size;
            if (end > n) break;
            if (id === EBML) { this.scale = 1000000; this.clusterTime = 0; }
            else if (id === TIMECODE_SCALE) this.scale = uint(d, body, end);
            else if (id === WIDTH) this.width = uint(d, body, end);
            else if (id === HEIGHT) this.height = uint(d, body, end);
            else if (id === CLUSTER_TIME) this.clusterTime = uint(d, body, end);
            else if ((id === SIMPLE_BLOCK || id === BLOCK) && size > 4) {
                var t = d[body] & 0x80 ? 1 : d[body] & 0x40 ? 2 : 3;
                var rel = (d[body + t] << 8) | d[body + t + 1];
                if (rel & 0x8000) rel -= 0x10000;
                var data = body + t + 3;
                // A SimpleBlock says whether it is a keyframe; otherwise the VP9 frame header does.
                var key = id === SIMPLE_BLOCK ? !!(d[body + t + 2] & 0x80) : (d[data] & 0x0C) === 0;
                frames.push({
                    pts: (this.clusterTime + rel) * this.scale / 1e9 + this.timestampOffset,
                    key: key, start: data, end: end
                });
            }
            p = end;
        }
        if (frames.length) this.send(d, frames);
        this.pending = p >= n ? new Uint8Array(0) : d.slice(p);
    };

    // One message per append: a 21-byte header, then for each frame its time, keyframe flag, length
    // and bytes.
    Fake.prototype.send = function (d, frames) {
        var total = 21, i, f;
        for (i = 0; i < frames.length; i++) {
            f = frames[i];
            var gap = f.pts - this.lastPts;
            if (this.lastPts >= 0 && gap > 0.001 && gap < 0.2) this.frameTime = gap;
            this.lastPts = f.pts;
            total += 13 + (f.end - f.start);
        }
        var buf = new ArrayBuffer(total), view = new DataView(buf), out = new Uint8Array(buf), o = 21;
        view.setUint8(0, 2);
        view.setUint32(1, this.id, true);
        view.setUint32(5, this.width, true);
        view.setUint32(9, this.height, true);
        view.setUint32(13, Math.round(this.frameTime * 1e6), true);
        view.setUint32(17, frames.length, true);
        for (i = 0; i < frames.length; i++) {
            f = frames[i];
            view.setFloat64(o, f.pts, true);
            view.setUint8(o + 8, f.key ? 1 : 0);
            view.setUint32(o + 9, f.end - f.start, true);
            out.set(d.subarray(f.start, f.end), o + 13);
            o += 13 + (f.end - f.start);
        }
        post(buf);
        this.addRange(frames[0].pts, frames[frames.length - 1].pts + this.frameTime);
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

    Fake.prototype.abort = function () { this.pending = new Uint8Array(0); this.lastPts = -1; };
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

    function close(fake) {
        fake.closed = true;
        if (nv.current !== fake) return;
        nv.current = null;
        seeThrough(false);
        post({ t: 'stop', id: fake.id });
    }

    var realAdd = MediaSource.prototype.addSourceBuffer, realRemove = MediaSource.prototype.removeSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (type) {
        if (!nv.on() || !/^video\/webm/.test(type) || !/vp0?9/.test(type) || /vp9\.2|vp09\.0[23]/.test(type)) {
            return realAdd.apply(this, arguments);
        }
        var fake = new Fake(type, nv.nextId++);
        if (nv.current) nv.current.closed = true;
        nv.current = fake;
        seeThrough(true);
        post({ t: 'open', id: fake.id });
        this.addEventListener('sourceclose', function () { close(fake); });
        startClock();
        return fake;
    };
    MediaSource.prototype.removeSourceBuffer = function (sb) {
        if (sb instanceof Fake) { close(sb); return; }
        return realRemove.apply(this, arguments);
    };

    // The page's clock, and where on the screen the picture belongs.
    var clockVideo = null, clockTimer = 0;
    function tick() {
        var fake = nv.current;
        if (!fake) return;
        var v = document.querySelector('video');
        if (!v) return;
        if (v !== clockVideo) {
            clockVideo = v;
            ['play', 'pause', 'playing', 'waiting', 'seeking', 'seeked', 'ratechange', 'ended'].forEach(function (n) {
                v.addEventListener(n, tick);
            });
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
