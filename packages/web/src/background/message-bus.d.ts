import type { VaultSummary } from './vault-session';
export type KeetarRequest = {
    type: 'UNLOCK_VAULT';
    uuid: string;
    password: string;
} | {
    type: 'LOCK_VAULT';
} | {
    type: 'GET_STATUS';
};
export type KeetarResponse = {
    ok: true;
    type: 'UNLOCK_VAULT';
    summary: VaultSummary;
} | {
    ok: true;
    type: 'LOCK_VAULT';
} | {
    ok: true;
    type: 'GET_STATUS';
    status: 'locked' | 'unlocked';
} | {
    ok: false;
    error: string;
};
export type KeetarRequestHandler = (request: KeetarRequest) => Promise<KeetarResponse>;
/** Registers the background service worker's single message listener. */
export declare function registerMessageHandler(handle: KeetarRequestHandler): void;
/** Sends a request from a UI surface (only usable from a document context). */
export declare function sendToBackground(request: KeetarRequest): Promise<KeetarResponse>;
//# sourceMappingURL=message-bus.d.ts.map