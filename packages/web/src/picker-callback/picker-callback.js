// Firefox Picker bridge callback: relay result via chrome.runtime.sendMessage, then close.
(function () {
    var raw = window.location.hash.slice(1);
    var result;
    try {
        result = raw ? JSON.parse(decodeURIComponent(raw)) : { error: 'no result data received' };
    } catch (e) {
        result = { error: 'failed to parse Picker result' };
    }
    chrome.runtime.sendMessage(Object.assign({ type: 'KEETAR_PICKER_CALLBACK' }, result));
    window.close();
})();
