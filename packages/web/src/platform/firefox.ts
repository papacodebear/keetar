// Firefox-specific platform shim (§9.2). MV2 persistent background page +
// browser.* APIs (promise-based natively). Full Firefox support is Phase 11 —
// this shim exists now only so platform/index.ts's detection has a real
// target; it isn't exercised until packaging/testing against Firefox starts.
//
// Minimal ambient declaration rather than pulling in a WebExtension types
// package before Firefox work actually begins — scoped to exactly what this
// shim uses.
declare const browser: {
    storage: {
        local: {
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

export const idle = {
    setDetectionInterval(seconds: number): void {
        browser.idle.setDetectionInterval(seconds);
    },
    onStateChanged(callback: (state: 'active' | 'idle' | 'locked') => void): void {
        browser.idle.onStateChanged.addListener(callback);
    }
};

// No-op: Firefox MV2's background page is persistent, so there's no service
// worker to keep alive (§9.3). Typed against chrome.alarms.* (from
// @types/chrome, harmless to reference here even though the body never
// touches the real chrome/browser runtime) so platform/index.ts's re-export
// has one consistent callback shape regardless of which shim is live.
export const alarms = {
    create(_name: string, _alarmInfo: chrome.alarms.AlarmCreateInfo): void {
        // intentionally no-op
    },
    onAlarm(_callback: (alarm: chrome.alarms.Alarm) => void): void {
        // intentionally no-op
    }
};

// No `runtime` export: message-bus.ts talks to `chrome.runtime` directly —
// Firefox also accepts the `chrome.*` namespace for messaging (§9.1), so no
// shim is needed there either.
