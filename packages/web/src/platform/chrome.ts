// Chrome MV3 shim: service worker with chrome.* APIs (§9.2).

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

// Same promise-return pattern for tabs.query (used for active tab matching).
export const tabs = {
    query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<chrome.tabs.Tab[]> {
        return chrome.tabs.query(queryInfo);
    },
    sendMessage(tabId: number, message: unknown): Promise<void> {
        return chrome.tabs.sendMessage(tabId, message);
    },
    onRemoved(callback: (tabId: number) => void): void {
        chrome.tabs.onRemoved.addListener(callback);
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
    }
};
