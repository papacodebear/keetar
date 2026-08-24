import type { PasskeyAlgorithm } from './webauthn-crypto.js';

// Shared shape both storage backends (native-storage.ts, keepassxc-storage.ts) read and write.
export interface PasskeyRecord {
    credentialId: Uint8Array;
    privateKeyPkcs8: Uint8Array;
    userHandle: Uint8Array;
    algorithm: PasskeyAlgorithm;
    rpId: string;
    username: string;
    signCount: number;
}
