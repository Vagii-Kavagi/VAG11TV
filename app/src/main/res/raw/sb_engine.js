// SponsorBlock skipper for the YouTube TV page.
// Mode per category (Prefs.java): 0 = auto skip, 1 = show a skip button, 2 = off.
(function () {
    if (window.top !== window || window.__vag11sb) return;
    var bridge = window.VAG11;
    if (!bridge) return;

    var cfg = { enabled: false, cats: {} };
    try { cfg = JSON.parse(bridge.getConfig()); } catch (e) { }

    var NAMES = {
        sponsor: 'sponsor', selfpromo: 'self promotion', interaction: 'interaction reminder',
        intro: 'intro', outro: 'endcards', preview: 'preview', music_offtopic: 'non-music section',
        filler: 'filler'
    };

    var segs = [];
    var curVid = null;
    var box = null;       // one element: the skip button, or the "skipped" notice
    var askSeg = null;    // segment the skip button is offering
    var doneUuid = {};    // segments already skipped or passed once, so rewinding into one works
    var hideTimer = 0;

    function videoEl() { return document.querySelector('video'); }

    function vidFromUrl() {
        var m = (location.hash || '').match(/[?&]v=([A-Za-z0-9_-]{11})/);
        return m ? m[1] : null;
    }

    function modeOf(cat) {
        var m = (cfg.cats || {})[cat];
        return (m === 0 || m === 1) ? m : 2;
    }

    function ensureBox() {
        if (!box) {
            box = document.createElement('div');
            box.style.cssText = [
                'position:fixed', 'right:4vw', 'bottom:22vh', 'z-index:2147483647',
                'padding:1.2vh 1.6vw', 'border-radius:1vh',
                'background:rgba(15,15,15,0.92)', 'color:#fff',
                'font:500 2.6vh Roboto,Arial,sans-serif',
                'border:0.25vh solid #00D400', 'display:none'
            ].join(';');
        }
        // YouTube re-renders its root, so put the element back when it has been dropped.
        if (!box.isConnected) {
            try { (document.body || document.documentElement).appendChild(box); } catch (e) { }
        }
        return box;
    }

    function show(text, ms) {
        ensureBox();
        box.textContent = text;
        box.style.display = 'block';
        clearTimeout(hideTimer);
        if (ms) hideTimer = setTimeout(hide, ms);
    }

    function hide() {
        if (box) box.style.display = 'none';
        askSeg = null;
    }

    function skip(v, s) {
        doneUuid[s.uuid] = true;
        askSeg = null;
        try { v.currentTime = Math.min(s.end, v.duration - 0.5); } catch (e) { }
        show('Skipped ' + (NAMES[s.cat] || s.cat), 2500);
    }

    // An advert plays in the same <video> under the same URL. Its length differs from the video the
    // segments were reported for, and that is the only thing that tells the two apart here.
    function isThisVideo(v, s) {
        if (!isFinite(v.duration) || v.duration <= 0) return false;
        if (s.end > v.duration + 1) return false;
        if (s.videoDuration > 0 && Math.abs(v.duration - s.videoDuration) > 5) return false;
        return true;
    }

    function tick() {
        var id = vidFromUrl();
        if (id !== curVid) {
            curVid = id;
            segs = [];
            doneUuid = {};
            hide();
            if (id && cfg.enabled) bridge.fetchSegments(id);
        }
        var v = videoEl();
        if (!v || !id || !cfg.enabled || !segs.length) {
            if (askSeg) hide();
            return;
        }

        var t = v.currentTime;
        var inside = null;
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i];
            if (t >= s.start && t < s.end - 0.5 && modeOf(s.cat) !== 2 && isThisVideo(v, s)) {
                inside = s;
                break;
            }
        }
        if (!inside) {
            if (askSeg) hide();
            return;
        }
        if (doneUuid[inside.uuid]) return;
        if (modeOf(inside.cat) === 0) {
            skip(v, inside);
        } else if (askSeg !== inside) {
            askSeg = inside;
            show('Skip ' + (NAMES[inside.cat] || inside.cat) + '  •  press OK', 0);
        }
    }

    // While the skip button is up, OK presses it instead of reaching the player.
    window.addEventListener('keydown', function (e) {
        if (!askSeg || e.keyCode !== 13) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        var v = videoEl();
        if (v) skip(v, askSeg);
    }, true);
    window.addEventListener('keyup', function (e) {
        if (askSeg && e.keyCode === 13) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    window.__vag11sb = {
        setConfig: function (c) {
            var was = cfg.enabled;
            cfg = c || cfg;
            if (cfg.enabled && !was) curVid = null; // fetch for the video that is already open
            if (!cfg.enabled) hide();
        },
        onSegments: function (id, list) {
            if (id === curVid) segs = list || [];
        },
        state: function () {
            var v = videoEl();
            return { vid: curVid, segs: segs, cfg: cfg, t: v ? v.currentTime : null, d: v ? v.duration : null };
        }
    };

    setInterval(function () {
        try { tick(); } catch (e) { bridge.log('tick: ' + e); }
    }, 400);
})();
