// Firefox MV2 shim: persistent background page with promise-based browser.* APIs (§9.2).
declare const browser: {
    storage: {
        local: {
            get(key: string): Promise<Record<string, unknown>>;
            set(items: Record<string, unknown>): Promise<void>;
            remove(key: string): Promise<void>;
        };
        session: {
            get(key: string): Promise<Record<string, unknown>>;
            set(items: Record<string, unknown>): Promise<void>;
            remove(key: string): Promise<void>;
        };
    };
    idle: {
        setDetectionInterval(seconds: number): void;
        onStateChanged: {
            addListener(callback: (state: 'active' | 'idle' | 'locked') => void): void;
        };
    };
    identity: {
        getRedirectURL(path?: string): string;
        launchWebAuthFlow(details: { url: string; interactive?: boolean }): Promise<string>;
    };
    browserAction: {
        setBadgeText(details: { tabId: number; text: string }): Promise<void>;
        setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void>;
    };
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
    };
    tabs: {
        query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
        update(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab>;
        sendMessage(tabId: number, message: unknown): Promise<void>;
        onRemoved: {
            addListener(callback: (tabId: number) => void): void;
        };
    };
};

export const storage = {
    async get<T>(key: string): Promise<T | undefined> {
        const result = await browser.storage.local.get(key);
        return result[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
        await browser.storage.local.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
        await browser.storage.local.remove(key);
    }
};

// Firefox's persistent MV2 background keeps this in memory; storage.session also clears with the browser session.
export const sessionStorage = {
    async get<T>(key: string): Promise<T | undefined> {
        const result = await browser.storage.session.get(key);
        return result[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
        await browser.storage.session.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
        await browser.storage.session.remove(key);
    }
};

export const idle = {
    setDetectionInterval(seconds: number): void {
        browser.idle.setDetectionInterval(seconds);
    },
    onStateChanged(callback: (state: 'active' | 'idle' | 'locked') => void): void {
        browser.idle.onStateChanged.addListener(callback);
    }
};

// No-op: Firefox MV2 has persistent background (no service worker to keep alive; §9.3).
export const alarms = {
    create(_name: string, _alarmInfo: chrome.alarms.AlarmCreateInfo): void {
        // intentionally no-op
    },
    onAlarm(_callback: (alarm: chrome.alarms.Alarm) => void): void {
        // intentionally no-op
    }
};

// Firefox's chrome.runtime.sendMessage returns undefined; use native browser.runtime instead.
export const runtime = {
    sendMessage<T>(message: unknown): Promise<T> {
        return browser.runtime.sendMessage(message) as Promise<T>;
    }
};

// Same promise-return gap for tab operations; use browser.tabs instead.
export const tabs = {
    query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
        return browser.tabs.query(queryInfo);
    },
    update(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab> {
        return browser.tabs.update(tabId, updateProperties);
    },
    sendMessage(tabId: number, message: unknown): Promise<void> {
        return browser.tabs.sendMessage(tabId, message);
    },
    onRemoved(callback: (tabId: number) => void): void {
        browser.tabs.onRemoved.addListener(callback);
    }
};

// browser.identity.launchWebAuthFlow rejects on cancel (handled same as chrome.ts; §7.3).
export const identity = {
    getRedirectURL(path?: string): string {
        return browser.identity.getRedirectURL(path);
    },
    async launchWebAuthFlow(options: { url: string; interactive: boolean }): Promise<string | undefined> {
        return browser.identity.launchWebAuthFlow(options);
    }
};

// MV2 uses browserAction; Chrome MV3 uses action (§5.1, §9.1).
export const action = {
    setBadgeText(details: { tabId: number; text: string }): Promise<void> {
        return browser.browserAction.setBadgeText(details);
    },
    setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void> {
        return browser.browserAction.setBadgeBackgroundColor(details);
    }
};
