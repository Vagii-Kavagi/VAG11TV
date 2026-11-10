// Ad blocker for the YouTube TV page.
//
// YouTube tells the page which adverts to show inside the same JSON that describes a video or a
// feed. Taking the advert parts out of that data, before the page reads it, means there is nothing
// for it to play or draw:
//   - a video's response: adPlacements, playerAds, adSlots (pre-roll, mid-roll and end adverts)
//   - a feed's response: adSlotRenderer entries (the Home masthead and "Sponsored" tiles)
//   - Shorts: entries marked as adverts
// Switched in Settings > Ad blocking; a change applies to what is loaded next.
(function () {
    if (window.top !== window || window.__vag11ads) return;
    var bridge = window.VAG11;
    if (!bridge) return;

    var on = false;
    try { on = !!JSON.parse(bridge.getConfig()).adblock; } catch (e) { }
    var stats = { videos: 0, feedAds: 0, shorts: 0 };

    function isAdItem(x) {
        return x && typeof x === 'object' && (x.adSlotRenderer || x.tvMastheadRenderer);
    }

    // Removes advert entries from every list under `node`. Feeds are a few levels of lists of
    // shelves of tiles, so the walk is bounded by depth.
    function sweep(node, depth) {
        if (!node || typeof node !== 'object' || depth > 14) return;
        if (Array.isArray(node)) {
            for (var i = node.length - 1; i >= 0; i--) {
                if (isAdItem(node[i])) { node.splice(i, 1); stats.feedAds++; }
                else sweep(node[i], depth + 1);
            }
            return;
        }
        for (var k in node) {
            var v = node[k];
            if (v && typeof v === 'object') sweep(v, depth + 1);
        }
    }

    function clean(r) {
        if (!r || typeof r !== 'object') return;
        // A video.
        if (r.adPlacements || r.playerAds || r.adSlots) {
            if (r.adPlacements) r.adPlacements = [];
            if (r.playerAds) r.playerAds = [];
            if (r.adSlots) r.adSlots = [];
            if (r.adBreakHeartbeatParams) delete r.adBreakHeartbeatParams;
            stats.videos++;
        }
        // A feed, or more rows of one.
        if (r.contents || r.continuationContents || r.onResponseReceivedActions) {
            sweep(r.contents, 0);
            sweep(r.continuationContents, 0);
            sweep(r.onResponseReceivedActions, 0);
        }
        // Shorts.
        if (Array.isArray(r.entries)) {
            var before = r.entries.length;
            r.entries = r.entries.filter(function (e) {
                var w = e && e.command && e.command.reelWatchEndpoint;
                return !(w && w.adClientParams && w.adClientParams.isAd);
            });
            stats.shorts += before - r.entries.length;
        }
    }

    var parse = JSON.parse;
    JSON.parse = function () {
        var r = parse.apply(this, arguments);
        if (on) {
            try { clean(r); } catch (e) { bridge.log('ad block: ' + e); }
        }
        return r;
    };

    window.__vag11ads = {
        set: function (v) { on = !!v; },
        state: function () { return { on: on, stats: stats }; }
    };
})();
