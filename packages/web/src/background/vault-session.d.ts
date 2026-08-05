import { Kdbx } from '@keetar/core';
export interface VaultSummary {
    rootGroupName: string;
    entryCount: number;
    entryTitles: string[];
}
type VaultSessionState = {
    status: 'locked';
} | {
    status: 'unlocked';
    uuid: string;
    db: Kdbx;
};
declare class VaultSession {
    private state;
    get status(): VaultSessionState['status'];
    unlock(uuid: string, password: string): Promise<VaultSummary>;
    lock(): void;
}
export declare const vaultSession: VaultSession;
export {};
//# sourceMappingURL=vault-session.d.ts.map