// Makes playback start sooner and run without stutter in a WebView.
//
// 1. Formats. YouTube offers each video in several codecs and sizes and picks one itself. Measured
//    on a MiTV-MSSP2, its picks dropped frames badly in two cases, so those formats are taken out of
//    the list before the player sees it:
//      - AV1, which this WebView decodes in software (about 1 frame in 5 dropped at 720p);
//      - sizes above the screen the WebView draws on (1080p on a 720p surface: 1 frame in 2 dropped,
//        for no extra detail, because the picture is scaled down to the surface anyway).
//    H.264 and VP9 stay, both hardware decoded. If nothing would be left, the list is not touched.
// 2. Connection. The video comes from a googlevideo.com host that the page only contacts once the
//    video's data has arrived. The hosts used lately are remembered and connected to as soon as a
//    video is opened, so that handshake is not spent while the screen is black.
(function () {
    if (window.top !== window || window.__vag11player) return;
    window.__vag11player = true;

    // Tallest picture the surface can show, with a little slack for odd sizes such as 1920x1088.
    // native_video.js raises the ratio the page sees; the surface's real one is asked for here.
    var ratio = window.__vag11nv && window.__vag11nv.realRatio ? window.__vag11nv.realRatio() : window.devicePixelRatio;
    var maxHeight = Math.max(480, Math.round(window.screen.height * (ratio || 1))) * 1.06;

    // AV1 stays out unless the WebView says it has a hardware decoder for it.
    var av1Hardware = false;
    try {
        navigator.mediaCapabilities.decodingInfo({
            type: 'media-source',
            video: { contentType: 'video/mp4; codecs="av01.0.05M.08"', width: 1280, height: 720, bitrate: 2000000, framerate: 30 }
        }).then(function (r) { av1Hardware = !!(r && r.supported && r.powerEfficient); }, function () { });
    } catch (e) { }

    // With the native picture on (native_video.js) the limits are that decoder's: H.264, within
    // 1920x1088. An ultra-wide video's 1080p is wider than that, so it gets its next size down.
    function keepNative(f) {
        if (!f || !f.height) return true; // audio
        var m = f.mimeType || '', nv = window.__vag11nv;
        return /^video\/mp4/.test(m) && /avc[13]/.test(m)
            && f.height <= nv.maxHeight && (f.width || 0) <= nv.maxWidth;
    }

    function keep(f) {
        if (!f || !f.height) return true; // audio
        if (f.height > maxHeight) return false;
        if (!av1Hardware && /av01/.test(f.mimeType || '')) return false;
        return true;
    }

    var HOSTS_KEY = 'vag11.videoHosts';
    function recentHosts() {
        try { return JSON.parse(localStorage.getItem(HOSTS_KEY)) || []; } catch (e) { return []; }
    }
    function rememberHost(url) {
        var m = /^https:\/\/([a-z0-9.-]+\.googlevideo\.com)\//.exec(url || '');
        if (!m) return;
        var hosts = recentHosts().filter(function (h) { return h !== m[1]; });
        hosts.unshift(m[1]);
        try { localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts.slice(0, 3))); } catch (e) { }
    }

    var parse = JSON.parse;
    JSON.parse = function () {
        var r = parse.apply(this, arguments);
        try {
            var sd = r && r.streamingData;
            if (sd && Array.isArray(sd.adaptiveFormats)) {
                var hasVideo = function (f) { return f.height; };
                var kept = [];
                if (window.__vag11nv && window.__vag11nv.on()) kept = sd.adaptiveFormats.filter(keepNative);
                if (!kept.some(hasVideo)) kept = sd.adaptiveFormats.filter(keep);
                if (kept.some(hasVideo)) sd.adaptiveFormats = kept;
                rememberHost(sd.serverAbrStreamingUrl || (sd.adaptiveFormats[0] || {}).url);
            }
        } catch (e) { }
        return r;
    };

    // Requests with and without cookies use separate connections, so open one of each.
    function preconnect() {
        if (!/^#\/watch/.test(location.hash || '')) return;
        var head = document.head || document.documentElement;
        recentHosts().forEach(function (h) {
            ['', 'anonymous'].forEach(function (mode) {
                var l = document.createElement('link');
                l.rel = 'preconnect';
                l.href = 'https://' + h;
                if (mode) l.crossOrigin = mode;
                head.appendChild(l);
                setTimeout(function () { if (l.parentNode) l.parentNode.removeChild(l); }, 15000);
            });
        });
    }
    window.addEventListener('hashchange', preconnect);
})();
