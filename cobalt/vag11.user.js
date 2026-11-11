// VAG11TV for Cobalt: the additions to YouTube's TV interface, in one script.
//
// The app is YouTube's own TV engine (Cobalt, built by TizenTubeCobalt). The engine loads this
// script into youtube.com/tv; nothing else of YouTube's is changed. It adds:
//   1. Ad blocking: the advert parts are taken out of YouTube's data before the page reads it.
//   2. Two entries in YouTube's Settings, "Ad blocking" and "SponsorBlock", each opening a menu.
//   3. SponsorBlock: segments the community reported are skipped, or offered with a skip button.
// Choices are kept on the TV (localStorage). Nothing is sent anywhere except the SponsorBlock
// lookup, which carries only the first 4 characters of the SHA-256 of the video id.
(function () {
    if (window.top !== window || window.__vag11) return;
    window.__vag11 = { version: '1.1.6' };

    // ---- choices -------------------------------------------------------------------------------

    var AUTO = 0, ASK = 1, OFF = 2;
    var MODE_NAMES = ['Auto skip', 'Skip button', 'Off'];
    var CATS = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'music_offtopic', 'filler'];
    var CAT_NAMES = {
        sponsor: 'Sponsor', selfpromo: 'Unpaid / self promotion', interaction: 'Interaction reminder (subscribe)',
        intro: 'Intro', outro: 'Endcards / credits', preview: 'Preview / recap',
        music_offtopic: 'Non-music section', filler: 'Filler / tangent'
    };
    var SHORT_NAMES = {
        sponsor: 'sponsor', selfpromo: 'self promotion', interaction: 'interaction reminder', intro: 'intro',
        outro: 'endcards', preview: 'preview', music_offtopic: 'non-music section', filler: 'filler'
    };
    var KEY = 'vag11.config';

    function defaults() {
        var cats = {};
        CATS.forEach(function (c) { cats[c] = c === 'sponsor' ? AUTO : OFF; });
        return { adblock: true, sb: true, cats: cats };
    }

    var cfg = defaults();
    try {
        var saved = JSON.parse(localStorage.getItem(KEY));
        if (saved && typeof saved === 'object') {
            if (typeof saved.adblock === 'boolean') cfg.adblock = saved.adblock;
            if (typeof saved.sb === 'boolean') cfg.sb = saved.sb;
            CATS.forEach(function (c) {
                var m = saved.cats && saved.cats[c];
                if (m === AUTO || m === ASK || m === OFF) cfg.cats[c] = m;
            });
        }
    } catch (e) { }

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { }
    }

    // As warnings: the engine copies only warnings and errors to the system log (adb logcat).
    function log(msg) {
        try { console.warn('[VAG11] ' + msg); } catch (e) { }
    }

    // ---- 1. ad blocking ------------------------------------------------------------------------
    //
    // A video's response: adPlacements, playerAds, adSlots (pre-roll, mid-roll and end adverts).
    // A feed's response: adSlotRenderer entries (the Home masthead and "Sponsored" tiles).
    // Shorts: entries marked as adverts.

    var adStats = { videos: 0, feedAds: 0, shorts: 0 };

    function isAdItem(x) {
        return x && typeof x === 'object' && (x.adSlotRenderer || x.tvMastheadRenderer);
    }

    // Advert entries are taken out of any list in the response, and an advert held directly in a
    // field is dropped. The TV interface nests feeds deeply (browse > surface > sections > shelves >
    // lists > tiles), deeper than the 14 levels this walk used to stop at, so it goes to 40.
    function sweep(node, depth) {
        if (!node || typeof node !== 'object' || depth > 40) return;
        if (Array.isArray(node)) {
            for (var i = node.length - 1; i >= 0; i--) {
                if (isAdItem(node[i])) { node.splice(i, 1); adStats.feedAds++; }
                else sweep(node[i], depth + 1);
            }
            return;
        }
        for (var k in node) {
            var v = node[k];
            if (!v || typeof v !== 'object') continue;
            if (k === 'adSlotRenderer' || k === 'tvMastheadRenderer') { delete node[k]; adStats.feedAds++; continue; }
            sweep(v, depth + 1);
        }
    }

    function cleanAds(r) {
        if (r.adPlacements || r.playerAds || r.adSlots) {
            if (r.adPlacements) r.adPlacements = [];
            if (r.playerAds) r.playerAds = [];
            if (r.adSlots) r.adSlots = [];
            if (r.adBreakHeartbeatParams) delete r.adBreakHeartbeatParams;
            adStats.videos++;
        }
        for (var key in r) {
            if (key !== 'entries' && r[key] && typeof r[key] === 'object') sweep(r[key], 0);
        }
        if (Array.isArray(r.entries)) {
            var before = r.entries.length;
            r.entries = r.entries.filter(function (e) {
                var w = e && e.command && e.command.reelWatchEndpoint;
                return !(w && w.adClientParams && w.adClientParams.isAd);
            });
            adStats.shorts += before - r.entries.length;
        }
    }

    // ---- 2. Settings entries -------------------------------------------------------------------
    //
    // YouTube builds its Settings page from a JSON response, so the entries are added to that data
    // and drawn and focused like its own rows. Choosing one sends a command only this script knows,
    // caught where the page resolves commands.

    var SB_CATEGORY = 'SETTING_CAT_VAG11_SPONSORBLOCK', ADS_CATEGORY = 'SETTING_CAT_VAG11_ADBLOCK';

    function settingsEntry(categoryId, title, summary, label, itemId, endpoint) {
        return {
            settingCategoryCollectionRenderer: {
                title: { runs: [{ text: title }] },
                categoryId: categoryId,
                focused: false,
                items: [{
                    settingActionRenderer: {
                        title: { runs: [{ text: title }] },
                        summary: { runs: [{ text: summary }] },
                        actionLabel: { runs: [{ text: label }] },
                        itemId: itemId,
                        serviceEndpoint: endpoint
                    }
                }]
            }
        };
    }

    function addSettingsEntries(r) {
        if (!Array.isArray(r.items) || !r.items.length || !r.items[0] || !r.items[0].settingCategoryCollectionRenderer) return;
        var has = r.items.some(function (it) {
            var c = it.settingCategoryCollectionRenderer;
            return c && c.categoryId === SB_CATEGORY;
        });
        if (has) return;
        // After YouTube's first, untitled group (Premium, Autoplay, Restricted mode...).
        r.items.splice(1, 0,
            settingsEntry(ADS_CATEGORY, 'Ad blocking',
                'Removes adverts before and during videos, the Home banner and Sponsored tiles.',
                'Open ad blocking', 'VAG11_ADBLOCK', { vag11OpenAdBlock: {} }),
            settingsEntry(SB_CATEGORY, 'SponsorBlock',
                'Skip sponsors and other segments reported by the SponsorBlock community. Choose what is skipped for each kind of segment.',
                'Open SponsorBlock', 'VAG11_SPONSORBLOCK', { vag11OpenSponsorBlock: {} }));
    }

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
                    if (cmd && cmd.vag11OpenSponsorBlock) { openMenu('sponsorblock'); return true; }
                    if (cmd && cmd.vag11OpenAdBlock) { openMenu('ads'); return true; }
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

    // ---- one hook on YouTube's data ------------------------------------------------------------

    var parse = JSON.parse;
    function edit(r) {
        if (r && typeof r === 'object') {
            try { if (cfg.adblock) cleanAds(r); } catch (e) { log('ad block: ' + e); }
            try { addSettingsEntries(r); } catch (e) { log('settings: ' + e); }
        }
        return r;
    }
    JSON.parse = function () {
        return edit(parse.apply(this, arguments));
    };

    // The page also reads responses with fetch(...).json(), which never goes through JSON.parse:
    // on Cobalt the Home feed arrives that way, so its adverts got past the hook above. Read as
    // text and parsed here, those responses get the same treatment.
    if (window.Response && Response.prototype.json) {
        Response.prototype.json = function () {
            return this.text().then(function (text) {
                return edit(parse(text));
            });
        };
    }

    // On screen. On Cobalt the TV interface gets its feeds in a binary format, so the adverts in
    // them (Home tiles, the banner at the top) cannot be taken out of the data. They are hidden
    // instead: YouTube draws a feed advert as ytlr-ad-slot-renderer. Any other element carrying a
    // "Sponsored" badge is hidden at its nearest advert-type ancestor, and its name logged once.
    var adStyle = document.createElement('style');
    adStyle.textContent = 'ytlr-ad-slot-renderer{display:none!important}';
    // Text nodes containing "Sponsored", also inside shadow roots, which ordinary searches miss.
    function findSponsored(root, out, depth) {
        if (!root || depth > 12) return;
        var walker = document.createTreeWalker(root, 5 /* elements and text */, null, false), n;
        while ((n = walker.nextNode())) {
            if (n.nodeType === 3) {
                if (n.nodeValue && n.nodeValue.indexOf('Sponsored') >= 0) out.push(n);
            } else if (n.shadowRoot) {
                findSponsored(n.shadowRoot, out, depth + 1);
            }
        }
    }
    // The parent, stepping out of a shadow root to its host.
    function up(e) {
        if (e.parentElement) return e.parentElement;
        var root = e.getRootNode && e.getRootNode();
        return root && root.host ? root.host : null;
    }
    function moveFocusOn() {
        setTimeout(function () {
            var t = document.activeElement || document.body;
            ['keydown', 'keyup'].forEach(function (type) {
                var ev = new KeyboardEvent(type, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true });
                try { Object.defineProperty(ev, 'keyCode', { get: function () { return 39; } }); } catch (e) { }
                try { Object.defineProperty(ev, 'which', { get: function () { return 39; } }); } catch (e) { }
                t.dispatchEvent(ev);
            });
            log('moved focus off a hidden advert');
        }, 0);
    }
    function hideAds() {
        if (!cfg.adblock) { if (adStyle.parentNode) adStyle.parentNode.removeChild(adStyle); return; }
        if (!adStyle.parentNode) (document.head || document.documentElement).appendChild(adStyle);
        if (!document.body) return;
        var found = [];
        findSponsored(document.body, found, 0);
        for (var i = 0; i < found.length; i++) {
            var chain = [], target = null;
            for (var e = found[i].parentElement || up(found[i]), d = 0; e && d < 24; e = up(e), d++) {
                var tag = e.tagName.toLowerCase();
                chain.push(tag);
                if (tag === 'ytlr-ad-slot-renderer' || tag === 'ytlr-tile-renderer' || /(^|-)(ad|ads|masthead|promo|promoted)(-|$)/.test(tag)) {
                    target = e;
                    if (tag !== 'ytlr-tile-renderer') break; // prefer the ad wrapper above the tile when there is one
                }
                if (tag === 'ytlr-shelf-renderer' || tag === 'body') break;
            }
            if (target && target.style.display !== 'none') {
                log('hid an advert on screen: ' + chain.join(' < '));
                // Hidden but still focused (it is often the first tile, focused at start): OK would
                // open it. Focus moves on to the next tile, as a press of Right would.
                if (target.contains(document.activeElement)) moveFocusOn();
                target.style.setProperty('display', 'none', 'important');
                adStats.feedAds++;
            }
        }
    }
    setInterval(function () { try { hideAds(); } catch (e) { log('hide ads: ' + e); } }, 1000);

    // ---- the menus -----------------------------------------------------------------------------
    //
    // Drawn over the page and driven by the remote: Up and Down move, OK or Left and Right change
    // the value, Back closes. While a menu is open no key reaches YouTube.

    var menu = null;  // { page, rows, index, el, armed }

    // Rows: 'toggle' (an on/off switch), 'cat' (a SponsorBlock category with its mode), and rows
    // that cannot be focused: 'section' (a small heading), 'stats' and 'note'.
    function menuRows(page) {
        if (page === 'ads') {
            return [
                { kind: 'toggle', label: 'Block ads', sub: 'Adverts in videos, the Home banner, Sponsored tiles and Shorts',
                    on: function () { return cfg.adblock; }, change: function () { cfg.adblock = !cfg.adblock; } },
                { kind: 'section', label: 'Blocked since the app started' },
                { kind: 'stats' },
                { kind: 'note', label: 'A change applies to what loads next.' }
            ];
        }
        var rows = [
            { kind: 'toggle', label: 'Skip segments', sub: 'Community-reported sponsors and other segments',
                on: function () { return cfg.sb; }, change: function () { cfg.sb = !cfg.sb; } },
            { kind: 'section', label: 'Categories' }
        ];
        CATS.forEach(function (c) {
            rows.push({
                kind: 'cat', cat: c, label: CAT_NAMES[c], value: function () { return MODE_NAMES[cfg.cats[c]]; },
                change: function (dir) { cfg.cats[c] = (cfg.cats[c] + (dir < 0 ? 2 : 1)) % 3; },
                dim: function () { return !cfg.sb; }
            });
        });
        rows.push({ kind: 'note', label: 'From sponsor.ajay.app. Only 4 characters of a hash of the video id leave the TV.' });
        return rows;
    }

    function focusable(r) { return r.kind === 'toggle' || r.kind === 'cat'; }

    function el(tag, css, text) {
        var e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (text != null) e.textContent = text;
        return e;
    }

    var FONT = 'Roboto,Arial,sans-serif';

    // The VAG11 mark: a red disc with a white skip-ahead sign.
    function markSvg(size) {
        var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 40 40');
        svg.style.cssText = 'width:' + size + ';height:' + size + ';flex:none';
        var c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', '20'); c.setAttribute('cy', '20'); c.setAttribute('r', '20'); c.setAttribute('fill', '#FF0033');
        var p = document.createElementNS(ns, 'path');
        p.setAttribute('d', 'M11 12 L20 20 L11 28 Z M20 12 L29 20 L20 28 Z'); p.setAttribute('fill', '#fff');
        svg.appendChild(c); svg.appendChild(p);
        return svg;
    }

    function toggleSwitch(on, focused) {
        var track = el('div', [
            'position:relative', 'flex:none', 'width:4.6vh', 'height:2.6vh', 'border-radius:1.3vh',
            'background:' + (on ? '#FF0033' : (focused ? '#909090' : '#5c5c5c')), 'transition:background .15s'
        ].join(';'));
        track.appendChild(el('div', [
            'position:absolute', 'top:0.3vh', 'left:' + (on ? '2.3vh' : '0.3vh'), 'width:2vh', 'height:2vh',
            'border-radius:50%', 'background:#fff', 'transition:left .15s'
        ].join(';')));
        return track;
    }

    function drawMenu() {
        var m = menu;
        m.el.textContent = '';

        var head = el('div', 'display:flex;align-items:center;gap:1.2vw;margin:0 0 3vh 0');
        head.appendChild(markSvg('5.2vh'));
        var titles = el('div', '');
        titles.appendChild(el('div', 'font:500 3.4vh ' + FONT + ';color:#fff;line-height:1.2', m.page === 'ads' ? 'Ad blocking' : 'SponsorBlock'));
        titles.appendChild(el('div', 'font:400 1.9vh ' + FONT + ';color:#aaa;margin-top:0.3vh', 'VAG11 TV'));
        head.appendChild(titles);
        m.el.appendChild(head);

        m.rows.forEach(function (r, i) {
            var focused = i === m.index;
            if (r.kind === 'section') {
                m.el.appendChild(el('div', 'font:500 1.8vh ' + FONT + ';color:#aaa;letter-spacing:0.08em;text-transform:uppercase;margin:2.6vh 1vw 1vh 1vw', r.label));
                return;
            }
            if (r.kind === 'note') {
                m.el.appendChild(el('div', 'font:400 1.8vh ' + FONT + ';color:#8a8a8a;margin:2.2vh 1vw 0 1vw;line-height:1.45', r.label));
                return;
            }
            if (r.kind === 'stats') {
                var grid = el('div', 'display:flex;gap:0.8vw;margin:0 0.4vw');
                [[adStats.videos, 'videos'], [adStats.feedAds, 'feed adverts'], [adStats.shorts, 'Shorts']].forEach(function (st) {
                    var card = el('div', 'flex:1;background:#2c2c2c;border-radius:1.4vh;padding:1.6vh 1vw');
                    card.appendChild(el('div', 'font:500 3.2vh ' + FONT + ';color:#fff', String(st[0])));
                    card.appendChild(el('div', 'font:400 1.7vh ' + FONT + ';color:#aaa;margin-top:0.2vh', st[1]));
                    grid.appendChild(card);
                });
                m.el.appendChild(grid);
                return;
            }
            var dim = r.dim && r.dim();
            var row = el('div', [
                'display:flex', 'align-items:center', 'gap:1vw', 'box-sizing:border-box',
                'padding:' + (r.kind === 'toggle' ? '1.6vh 1.4vw' : '1.15vh 1.4vw'), 'margin:0.35vh 0',
                'border-radius:999px', 'font:400 2.4vh ' + FONT,
                'background:' + (focused ? '#f1f1f1' : (r.kind === 'toggle' ? '#2c2c2c' : 'transparent')),
                'color:' + (focused ? '#0f0f0f' : '#fff'), 'opacity:' + (dim && !focused ? '0.45' : '1'),
                'transition:background .12s'
            ].join(';'));
            if (r.kind === 'cat') {
                row.appendChild(el('div', 'flex:none;width:1.4vh;height:1.4vh;border-radius:50%;background:' + (SEG_COLORS[r.cat] || '#fff')));
            }
            var text = el('div', 'flex:1;min-width:0');
            text.appendChild(el('div', r.kind === 'toggle' ? 'font-weight:500' : '', r.label));
            if (r.sub) text.appendChild(el('div', 'font-size:1.8vh;margin-top:0.3vh;color:' + (focused ? '#3f3f3f' : '#aaa'), r.sub));
            row.appendChild(text);
            if (r.kind === 'toggle') {
                row.appendChild(toggleSwitch(r.on(), focused));
            } else {
                var v = r.value();
                row.appendChild(el('div', 'flex:none;font-weight:500;font-size:2.1vh;color:' + (focused ? '#0f0f0f' : (v === 'Off' ? '#8a8a8a' : '#fff')),
                    focused ? '‹  ' + v + '  ›' : v));
            }
            m.el.appendChild(row);
        });

        m.el.appendChild(el('div', 'position:absolute;left:2.6vw;right:2.6vw;bottom:3.6vh;font:400 1.8vh ' + FONT + ';color:#8a8a8a',
            'OK or ‹ ›  change  ·  Back  close'));
    }

    function openMenu(page) {
        closeMenu();
        var panel = el('div', [
            'position:fixed', 'top:0', 'right:0', 'bottom:0', 'width:40vw', 'z-index:2147483647',
            'box-sizing:border-box', 'padding:5vh 2.6vw 8vh 2.6vw', 'overflow:hidden',
            'background:#212121', 'box-shadow:-1vw 0 4vw rgba(0,0,0,0.55)',
            'transform:translateX(100%)', 'transition:transform .2s ease-out'
        ].join(';'));
        // armed after the press that opened the menu is released, so that press cannot change a row
        var rows = menuRows(page), first = 0;
        while (first < rows.length && !focusable(rows[first])) first++;
        menu = { page: page, rows: rows, index: first, el: panel, armed: false };
        setTimeout(function () { if (menu) menu.armed = true; }, 600);
        (document.body || document.documentElement).appendChild(panel);
        drawMenu();
        requestAnimationFrame(function () { requestAnimationFrame(function () { panel.style.transform = 'translateX(0)'; }); });
    }

    function closeMenu() {
        if (menu && menu.el.parentNode) menu.el.parentNode.removeChild(menu.el);
        menu = null;
    }

    function moveFocus(dir) {
        var rows = menu.rows, i = menu.index;
        for (var n = 0; n < rows.length; n++) {
            i = (i + dir + rows.length) % rows.length;
            if (focusable(rows[i])) { menu.index = i; return; }
        }
    }

    var BACK_KEYS = { 27: 1, 8: 1, 461: 1, 10009: 1 };
    function onMenuKey(e) {
        if (!menu) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.type === 'keyup') { menu.armed = true; return; }
        if (e.type !== 'keydown' || !menu.armed || e.repeat) return;
        var k = e.keyCode, row = menu.rows[menu.index];
        if (BACK_KEYS[k]) { closeMenu(); return; }
        if (k === 38) moveFocus(-1);
        else if (k === 40) moveFocus(1);
        else if ((k === 13 || k === 39 || k === 37) && row && row.change) {
            row.change(k === 37 ? -1 : 1);
            save();
            if (menu.page === 'sponsorblock') sbChanged();
        }
        drawMenu();
    }
    ['keydown', 'keyup', 'keypress'].forEach(function (t) { window.addEventListener(t, onMenuKey, true); });

    // ---- 3. SponsorBlock -----------------------------------------------------------------------

    var segs = [], curVid = null, box = null, askSeg = null, doneUuid = {}, hideTimer = 0;

    // The watch page's player. The page has other <video> elements too (Home previews), so the
    // first one is not necessarily it.
    function videoEl() {
        var main = document.querySelector('.html5-main-video');
        if (main) return main;
        var all = document.querySelectorAll('video');
        for (var i = 0; i < all.length; i++) if (!all[i].paused) return all[i];
        return all[0] || null;
    }

    function vidFromUrl() {
        var m = (location.hash || '').match(/[?&]v=([A-Za-z0-9_-]{11})/);
        return m ? m[1] : null;
    }

    function hexPrefix(bytes) {
        var h = '';
        for (var i = 0; i < 2; i++) h += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        return h;
    }

    // SHA-256 of a short ASCII string; the WebCrypto one when there is one.
    function sha256(text) {
        var data = new Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) data[i] = text.charCodeAt(i) & 255;
        if (window.crypto && crypto.subtle && crypto.subtle.digest) {
            return crypto.subtle.digest('SHA-256', data).then(function (b) { return new Uint8Array(b); });
        }
        return Promise.resolve(sha256js(data));
    }

    function sha256js(msg) {
        var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
        var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        var len = msg.length, blocks = Math.ceil((len + 9) / 64), w = new Array(64), i, j;
        var buf = new Uint8Array(blocks * 64);
        buf.set(msg);
        buf[len] = 0x80;
        var bits = len * 8;
        buf[buf.length - 4] = (bits >>> 24) & 255; buf[buf.length - 3] = (bits >>> 16) & 255;
        buf[buf.length - 2] = (bits >>> 8) & 255; buf[buf.length - 1] = bits & 255;
        function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
        for (var b = 0; b < blocks; b++) {
            for (i = 0; i < 16; i++) {
                j = b * 64 + i * 4;
                w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
            }
            for (i = 16; i < 64; i++) {
                var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
            }
            var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
            for (i = 0; i < 64; i++) {
                var t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
                var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
                h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
            }
            H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
            H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
        }
        var out = new Uint8Array(32);
        for (i = 0; i < 8; i++) {
            out[i * 4] = (H[i] >>> 24) & 255; out[i * 4 + 1] = (H[i] >>> 16) & 255;
            out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255;
        }
        return out;
    }

    // The hash-prefix lookup: SponsorBlock answers for every video whose hash starts the same way,
    // and the one asked for is picked out here.
    function fetchSegments(id) {
        return sha256(id).then(function (hash) {
            var url = 'https://sponsor.ajay.app/api/skipSegments/' + hexPrefix(hash)
                + '?categories=' + encodeURIComponent(JSON.stringify(CATS));
            return fetch(url);
        }).then(function (res) {
            if (res.status !== 200) return []; // 404: nothing reported for this prefix
            return res.json();
        }).then(function (videos) {
            var out = [];
            (videos || []).forEach(function (v) {
                if (!v || v.videoID !== id) return;
                (v.segments || []).forEach(function (s) {
                    if (!s.segment || s.segment.length !== 2) return;
                    if ((s.actionType || 'skip') !== 'skip') return;
                    out.push({ cat: s.category, start: s.segment[0], end: s.segment[1], uuid: s.UUID, videoDuration: s.videoDuration || 0 });
                });
            });
            return out;
        });
    }

    function ensureBox() {
        if (!box) {
            box = el('div', [
                'position:fixed', 'right:4vw', 'bottom:22vh', 'z-index:2147483646',
                'padding:1.2vh 1.6vw', 'border-radius:1vh',
                'background:rgba(15,15,15,0.92)', 'color:#fff',
                'font:500 2.6vh Roboto,Arial,sans-serif',
                'border:0.25vh solid #00D400', 'display:none'
            ].join(';'));
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
        log('skipping ' + s.cat + ' ' + s.start.toFixed(1) + ' -> ' + s.end.toFixed(1));
        doneUuid[s.uuid] = true;
        askSeg = null;
        var to = Math.min(s.end, v.duration - 0.5);
        // Through YouTube's player, which keeps its own idea of the position: set on the element
        // alone, a jump can be undone by the player.
        var p = document.querySelector('.html5-video-player');
        try {
            if (p && typeof p.seekTo === 'function') p.seekTo(to, true);
            else v.currentTime = to;
        } catch (e) {
            try { v.currentTime = to; } catch (e2) { }
        }
        setTimeout(function () { log('after skip: at ' + v.currentTime.toFixed(1)); }, 1000);
        show('Skipped ' + (SHORT_NAMES[s.cat] || s.cat), 2500);
    }

    // An advert plays in the same <video> under the same URL. Its length differs from the video the
    // segments were reported for, and that is what tells the two apart.
    function isThisVideo(v, s) {
        if (!isFinite(v.duration) || v.duration <= 0) return false;
        if (s.end > v.duration + 1) return false;
        if (s.videoDuration > 0 && Math.abs(v.duration - s.videoDuration) > 5) return false;
        return true;
    }

    function sbChanged() {
        if (cfg.sb) curVid = null; // fetch again for the video that is open
        else hide();
    }

    // Marks on YouTube's progress bar, one per segment whose category is not Off, in the colours the
    // SponsorBlock project uses. The bar is ytlr-progress-bar; its track is the wide, few pixels high
    // bar inside (its class names change with YouTube releases, so it is found by its shape). YouTube
    // rebuilds the bar, so the marks are put back when they have been dropped.
    var SEG_COLORS = {
        sponsor: '#00d400', selfpromo: '#ffff00', interaction: '#cc00ff', intro: '#00ffff',
        outro: '#0202ed', preview: '#008fd6', music_offtopic: '#ff9900', filler: '#7300ff'
    };
    var marks = null;
    // YouTube redraws the bar as playback moves and drops what it did not put there, the marks too.
    // Waiting for the next tick to put them back made them blink; an observer puts them back before
    // the screen is painted.
    var marksTrack = null, marksObserver = null, marksRestored = 0, marksLogAt = 0;
    function watchTrack(track) {
        if (marksObserver) marksObserver.disconnect();
        marksTrack = track;
        if (!window.MutationObserver) return;
        marksObserver = new MutationObserver(function () {
            if (marks && !marks.isConnected && marksTrack && marksTrack.isConnected) {
                marksTrack.appendChild(marks);
                marksRestored++;
            }
        });
        marksObserver.observe(track, { childList: true });
    }

    function findTrack(bar) {
        var br = bar.getBoundingClientRect(), best = null, bestW = 0;
        if (br.width <= 0) return null;
        var divs = bar.querySelectorAll('div');
        for (var i = 0; i < divs.length; i++) {
            var r = divs[i].getBoundingClientRect();
            if (r.height > 0 && r.height <= 10 && r.width > br.width * 0.8 && r.width > bestW) {
                best = divs[i];
                bestW = r.width;
            }
        }
        return best;
    }

    function drawMarks(v) {
        var show = cfg.sb && v && segs.length && isFinite(v.duration) && v.duration > 0;
        var list = !show ? [] : segs.filter(function (s) { return cfg.cats[s.cat] !== OFF && isThisVideo(v, s); });
        var key = list.length ? curVid + '|' + Math.round(v.duration) + '|' + list.map(function (s) {
            return s.cat + s.start.toFixed(1);
        }).join(',') : '';
        var now = Date.now();
        if (marksRestored && now - marksLogAt > 5000) {
            log('marks put back ' + marksRestored + ' times after the bar was redrawn');
            marksRestored = 0;
            marksLogAt = now;
        }
        if (marks && marks.isConnected && marks.getAttribute('data-key') === key) return;
        if (marks && marks.parentNode) marks.parentNode.removeChild(marks);
        marks = null;
        if (!key) {
            if (marksObserver) { marksObserver.disconnect(); marksObserver = null; }
            marksTrack = null;
            return;
        }
        var bar = document.querySelector('ytlr-progress-bar');
        var track = bar && findTrack(bar);
        if (!track) return;
        marks = el('div', 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:1');
        marks.setAttribute('data-key', key);
        list.forEach(function (s) {
            marks.appendChild(el('div', [
                'position:absolute', 'top:0', 'height:100%',
                'left:' + (s.start / v.duration * 100) + '%',
                'width:' + Math.max(0.3, (s.end - s.start) / v.duration * 100) + '%',
                'background:' + (SEG_COLORS[s.cat] || '#fff')
            ].join(';')));
        });
        track.appendChild(marks);
        watchTrack(track);
    }

    function tick() {
        var id = vidFromUrl();
        if (id !== curVid) {
            curVid = id;
            segs = [];
            doneUuid = {};
            hide();
            if (id && cfg.sb) {
                fetchSegments(id).then(function (list) {
                    log('segments for ' + id + ': ' + list.map(function (s) {
                        return s.cat + ' ' + s.start.toFixed(0) + '-' + s.end.toFixed(0);
                    }).join(', '));
                    if (id === curVid) segs = list;
                }, function (e) { log('segments for ' + id + ' failed: ' + e); });
            }
        }
        var v = videoEl();
        try { drawMarks(id ? v : null); } catch (e) { log('marks: ' + e); }
        if (!v || !id || !cfg.sb || !segs.length) {
            if (askSeg) hide();
            return;
        }
        var t = v.currentTime, inside = null;
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i];
            if (t >= s.start && t < s.end - 0.5 && cfg.cats[s.cat] !== OFF && cfg.cats[s.cat] != null && isThisVideo(v, s)) {
                inside = s;
                break;
            }
        }
        if (!inside) {
            if (askSeg) hide();
            return;
        }
        if (doneUuid[inside.uuid]) return;
        if (cfg.cats[inside.cat] === AUTO) skip(v, inside);
        else if (askSeg !== inside) {
            askSeg = inside;
            show('Skip ' + (SHORT_NAMES[inside.cat] || inside.cat) + '  •  press OK', 0);
        }
    }

    // While the skip button is up, OK presses it instead of reaching the player.
    window.addEventListener('keydown', function (e) {
        if (menu || !askSeg || e.keyCode !== 13) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        var v = videoEl();
        if (v) skip(v, askSeg);
    }, true);
    window.addEventListener('keyup', function (e) {
        if (!menu && askSeg && e.keyCode === 13) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    setInterval(function () {
        try { tick(); } catch (e) { log('tick: ' + e); }
    }, 400);

    // For checking from devtools.
    window.__vag11.state = function () {
        var v = videoEl();
        return { cfg: cfg, ads: adStats, vid: curVid, segs: segs, t: v ? v.currentTime : null, d: v ? v.duration : null };
    };
    window.__vag11.openMenu = openMenu;
    log('loaded ' + window.__vag11.version + ', ad blocking ' + (cfg.adblock ? 'on' : 'off'));
})();
