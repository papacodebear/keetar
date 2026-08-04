import { stream, streamXOR } from '@stablelib/chacha';

const InitialKeystreamSize = 4096;

/**
 * getBytes() serves a single continuous keystream across many small,
 * independently-sized calls (one per protected field). @stablelib/chacha's
 * stream()/streamXOR() are stateless per call, so the only way to reproduce
 * that continuous stream is to regenerate a longer deterministic prefix
 * (same key+nonce always yields the same keystream from byte 0) whenever the
 * buffered prefix runs out, and slice from the running offset.
 */
export class ChaCha20 {
    private readonly _key: Uint8Array;
    private readonly _nonce: Uint8Array;
    // Starts empty rather than undefined/lazily-generated: a zero-length
    // getBytes() call (a real case — e.g. an empty protected field) must
    // still return a valid, if empty, slice rather than reading off `undefined`.
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
