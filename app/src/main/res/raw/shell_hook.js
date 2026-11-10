// YouTube leaves the app by calling window.close(), which does nothing in a WebView that the page
// did not open itself. Hand it to the activity so Back on the first screen exits, as on the stock app.
(function () {
    if (window.top !== window || window.__vag11shell || !window.VAG11) return;
    window.__vag11shell = true;
    window.close = function () { window.VAG11.exit(); };
})();
