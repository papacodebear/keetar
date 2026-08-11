import { stream, streamXOR } from '@stablelib/chacha';

const InitialKeystreamSize = 4096;

// getBytes() maintains continuous keystream across calls by regenerating deterministic prefixes.
export class ChaCha20 {
    private readonly _key: Uint8Array;
    private readonly _nonce: Uint8Array;
    // Starts empty to handle zero-length getBytes() calls (e.g. empty protected fields).
    private _keystream: Uint8Array = new Uint8Array(0);
    private _offset = 0;

    constructor(key: Uint8Array, nonce: Uint8Array) {
        this._key = key;
        this._nonce = nonce;
    }

    getBytes(numberOfBytes: number): Uint8Array {
        this.ensureKeystreamLength(this._offset + numberOfBytes);
        const out = this._keystream.slice(this._offset, this._offset + numberOfBytes);
        this._offset += numberOfBytes;
        return out;
    }

    encrypt(data: Uint8Array): Uint8Array {
        return streamXOR(this._key, this._nonce, data, new Uint8Array(data.length));
    }

    private ensureKeystreamLength(minLength: number): void {
        if (this._keystream.length >= minLength) {
            return;
        }
        const newLength = Math.max(minLength, Math.max(this._keystream.length * 2, InitialKeystreamSize));
        this._keystream = stream(this._key, this._nonce, new Uint8Array(newLength));
    }
}
