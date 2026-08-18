// Shared between platform/chrome.ts (sender) and offscreen-clipboard.ts (receiver) — Chrome-only,
// since only Chrome's MV3 service worker needs an offscreen document to touch the clipboard.
export const OFFSCREEN_CLEAR_CLIPBOARD_MESSAGE = 'OFFSCREEN_CLEAR_CLIPBOARD_IF_MATCHES';

export interface OffscreenClearClipboardMessage {
    type: typeof OFFSCREEN_CLEAR_CLIPBOARD_MESSAGE;
    valueHashBase64: string;
}
