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
    create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): void;
    onAlarm(callback: (alarm: chrome.alarms.Alarm) => void): void;
};
//# sourceMappingURL=chrome.d.ts.map