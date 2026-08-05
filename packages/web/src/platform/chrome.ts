// Chrome-specific platform shim (§9.2). MV3 service worker + chrome.* APIs.

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

// No `runtime` export: message-bus.ts talks to `chrome.runtime` directly —
// Firefox also accepts the `chrome.*` namespace for messaging (§9.1), so no
// shim is needed there either.
