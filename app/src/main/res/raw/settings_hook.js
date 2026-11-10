// Adds one "SponsorBlock" entry to YouTube's own Settings page.
//
// The page builds Settings from a JSON response, so the entry is added to that data and YouTube draws
// and focuses it like its own rows. Choosing it sends a command only this file knows, which is caught
// where the page resolves commands and opens the native SponsorBlock menu.
(function () {
    if (window.top !== window || window.__vag11settings) return;
    window.__vag11settings = true;
    var bridge = window.VAG11;
    if (!bridge) return;

    var CATEGORY_ID = 'SETTING_CAT_VAG11_SPONSORBLOCK';

    function entry() {
        return {
            settingCategoryCollectionRenderer: {
                title: { runs: [{ text: 'SponsorBlock' }] },
                categoryId: CATEGORY_ID,
                focused: false,
                items: [{
                    settingActionRenderer: {
                        title: { runs: [{ text: 'SponsorBlock' }] },
                        summary: { runs: [{ text: 'Skip sponsors and other segments reported by the SponsorBlock community. Choose what is skipped for each kind of segment.' }] },
                        actionLabel: { runs: [{ text: 'Open SponsorBlock' }] },
                        itemId: 'VAG11_SPONSORBLOCK',
                        serviceEndpoint: { vag11OpenSponsorBlock: {} }
                    }
                }]
            }
        };
    }

    function isSettings(r) {
        return r && Array.isArray(r.items) && r.items.length > 0 && r.items[0] &&
            r.items[0].settingCategoryCollectionRenderer;
    }

    var parse = JSON.parse;
    JSON.parse = function () {
        var r = parse.apply(this, arguments);
        try {
            if (isSettings(r)) {
                var has = r.items.some(function (it) {
                    var c = it.settingCategoryCollectionRenderer;
                    return c && c.categoryId === CATEGORY_ID;
                });
                // After YouTube's first, untitled group (Premium, Autoplay, Restricted mode...).
                if (!has) r.items.splice(1, 0, entry());
            }
        } catch (e) {
            bridge.log('settings entry: ' + e);
        }
        return r;
    };

    function patchResolver() {
        var y = window._yttv;
        if (!y) return false;
        for (var k in y) {
            var inst = null;
            try { inst = y[k] && y[k].instance; } catch (e) { }
            if (!inst || typeof inst.resolveCommand !== 'function') continue;
            if (!inst.__vag11) {
                var orig = inst.resolveCommand;
                inst.resolveCommand = function (cmd) {
                    if (cmd && cmd.vag11OpenSponsorBlock) {
                        bridge.openSettings();
                        return true;
                    }
                    return orig.apply(this, arguments);
                };
                inst.__vag11 = true;
            }
            return true;
        }
        return false;
    }

    // The resolver appears once the app has started; look for it until then, and now and again
    // afterwards in case the page builds a new one.
    var tries = 0;
    (function look() {
        var ok = false;
        try { ok = patchResolver(); } catch (e) { }
        tries++;
        setTimeout(look, ok ? 10000 : (tries < 120 ? 500 : 5000));
    })();
})();
