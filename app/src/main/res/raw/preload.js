// Starts loading a video while its tile is selected, so that OK plays it almost at once.
//
// Most of the wait after OK is two round trips to YouTube's video servers (measured on a
// MiTV-MSSP2: about 1.3 s to the first byte of each, 2 to 5 s in all). YouTube's TV player can
// load a video ahead of time (preloadVideoByPlayerVars, the way the stock apps feel instant);
// nothing in the TV page asks it to. Here, a video tile that stays selected for half a second is
// preloaded. Measured: sound and picture 0.4 to 0.7 s after OK instead of 2 to 4 s.
//
// Only away from the watch page, so a playing video is never disturbed, and at most one preload
// every 1.5 s, so scrolling along a row does not fetch every tile.
(function () {
    if (window.top !== window || window.__vag11pre) return;
    var DWELL_MS = 500, GAP_MS = 1500;
    var pre = window.__vag11pre = { last: '', count: 0 };
    var focused = null, since = 0, lastAt = 0;

    function videoIdOf(tile) {
        // The tile's own data; its thumbnail address as a fallback.
        try {
            var props = tile.__instance && tile.__instance.props;
            var s = props && JSON.stringify(props, function (k, v) { return k === 'parent' ? undefined : v; });
            var m = s && /"videoId":"([\w-]{11})"/.exec(s);
            if (m) return m[1];
        } catch (e) { }
        var t = /i\.ytimg\.com\/vi(?:_webp)?\/([\w-]{11})\//.exec(tile.innerHTML || '');
        return t ? t[1] : '';
    }

    function check() {
        var a = document.activeElement;
        var tile = a && a.closest ? a.closest('ytlr-tile-renderer') : null;
        var now = Date.now();
        if (tile !== focused) { focused = tile; since = now; return; }
        if (!tile || now - since < DWELL_MS || now - lastAt < GAP_MS) return;
        if (/^#\/watch/.test(location.hash || '')) return;
        var id = videoIdOf(tile);
        if (!id || id === pre.last) return;
        var p = document.querySelector('.html5-video-player');
        if (!p || typeof p.preloadVideoByPlayerVars !== 'function') return;
        try {
            p.preloadVideoByPlayerVars({ videoId: id });
            pre.last = id;
            pre.count++;
            lastAt = now;
        } catch (e) { }
    }

    setInterval(check, 150);
})();
