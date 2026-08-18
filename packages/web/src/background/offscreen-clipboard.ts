import { ByteUtils } from '@keetar/core';
import { OFFSCREEN_CLEAR_CLIPBOARD_MESSAGE, type OffscreenClearClipboardMessage } from './offscreen-protocol';

// Chrome-only offscreen document (§ Options item 7) — the only context an MV3 service worker can
// delegate navigator.clipboard access to. Lives only for the duration of one clear check.
chrome.runtime.onMessage.addListener((message: OffscreenClearClipboardMessage, _sender, sendResponse) => {
    if (message?.type !== OFFSCREEN_CLEAR_CLIPBOARD_MESSAGE) {
        return;
    }
    void (async () => {
        try {
            const current = await navigator.clipboard.readText();
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(current));
            const currentHashBase64 = ByteUtils.bytesToBase64(new Uint8Array(digest));
            if (currentHashBase64 === message.valueHashBase64) {
                await navigator.clipboard.writeText('');
            }
        } finally {
            sendResponse(true);
        }
    })();
    return true;
});
