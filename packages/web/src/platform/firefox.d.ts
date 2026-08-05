export declare const storage: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
};
export declare const idle: {
    setDetectionInterval(seconds: number): void;
    onStateChanged(callback: (state: "active" | "idle" | "locked") => void): void;
};
export declare const alarms: {
    create(_name: string, _alarmInfo: chrome.alarms.AlarmCreateInfo): void;
    onAlarm(_callback: (alarm: chrome.alarms.Alarm) => void): void;
};
//# sourceMappingURL=firefox.d.ts.map