// Chrome MV3 shim: service worker with chrome.* APIs (§9.2).
import { OFFSCREEN_CLEAR_CLIPBOARD_MESSAGE } from '../background/offscreen-protocol';

export const storage = {
    async get<T>(key: string): Promise<T | undefined> {
        const result = await chrome.storage.local.get(key);
        return result[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
        await chrome.storage.local.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
        await chrome.storage.local.remove(key);
    }
};

// Session storage survives an MV3 service-worker restart but is never written to disk.
export const sessionStorage = {
    async get<T>(key: string): Promise<T | undefined> {
        const result = await chrome.storage.session.get(key);
        return result[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
        await chrome.storage.session.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
        await chrome.storage.session.remove(key);
    }
};

export const idle = {
    setDetectionInterval(seconds: number): void {
        chrome.idle.setDetectionInterval(seconds);
    },
    onStateChanged(callback: (state: 'active' | 'idle' | 'locked') => void): void {
        chrome.idle.onStateChanged.addListener(callback);
    }
};

export const alarms = {
    create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): void {
        chrome.alarms.create(name, alarmInfo);
    },
    onAlarm(callback: (alarm: chrome.alarms.Alarm) => void): void {
        chrome.alarms.onAlarm.addListener(callback);
    }
};

// Chrome.runtime.sendMessage returns Promise natively; Firefox needs firefox.ts shim instead.
export const runtime = {
    sendMessage<T>(message: unknown): Promise<T> {
        return chrome.runtime.sendMessage(message);
    }
};

// Same promise-return pattern for tab operations (used for matching and navigation).
export const tabs = {
    query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
        return chrome.tabs.query(queryInfo);
    },
    update(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab> {
        return chrome.tabs.update(tabId, updateProperties);
    },
    sendMessage(tabId: number, message: unknown): Promise<void> {
        return chrome.tabs.sendMessage(tabId, message);
    },
    onRemoved(callback: (tabId: number) => void): void {
        chrome.tabs.onRemoved.addListener(callback);
    }
};

// Raises an existing window when reusing a tab in it (tabs.update alone only activates within its own window).
export const windows = {
    update(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<chrome.windows.Window> {
        return chrome.windows.update(windowId, updateInfo);
    }
};

const OFFSCREEN_DOCUMENT_URL = 'offscreen-clipboard.html';

// A service worker has no focused document, so it can't touch navigator.clipboard directly —
// Chrome's documented workaround is a short-lived offscreen document to do the read/compare/write.
async function ensureOffscreenDocument(): Promise<void> {
    const existing = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });
    if (existing.length > 0) {
        return;
    }
    await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_URL,
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Read the clipboard to confirm it still holds what Keetar copied before auto-clearing it.'
    });
}

export const clipboard = {
    async clearIfMatches(valueHashBase64: string): Promise<void> {
        await ensureOffscreenDocument();
        await chrome.runtime.sendMessage({ type: OFFSCREEN_CLEAR_CLIPBOARD_MESSAGE, valueHashBase64 });
        await chrome.offscreen.closeDocument();
    }
};

// Google Drive OAuth via PKCE (shared implementation; getAuthToken Chrome-only; §7.3).
export const identity = {
    getRedirectURL(path?: string): string {
        return chrome.identity.getRedirectURL(path);
    },
    launchWebAuthFlow(options: { url: string; interactive: boolean }): Promise<string | undefined> {
        return chrome.identity.launchWebAuthFlow(options);
    }
};

// MV3 action.setBadgeText; Firefox MV2 uses browserAction (§5.1, §9.1).
export const action = {
    setBadgeText(details: { tabId: number; text: string }): Promise<void> {
        return chrome.action.setBadgeText(details);
    },
    setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void> {
        return chrome.action.setBadgeBackgroundColor(details);
    },
    setIcon(details: { path: Record<string, string> }): Promise<void> {
        return chrome.action.setIcon(details);
    }
};
