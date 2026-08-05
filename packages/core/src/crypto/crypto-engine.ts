import { KdbxError } from '../errors/kdbx-error.js';
import { ErrorCodes } from '../defs/consts.js';
import { arrayToBuffer, hexToBytes } from '../utils/byte-utils.js';
import { ChaCha20 } from './chacha20.js';

const EmptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const EmptySha512 =
    'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce' +
    '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';

// maxRandomQuota is the max number of random bytes you can asks for from the cryptoEngine
// https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues
const MaxRandomQuota = 65536;

// crypto.subtle's real runtime API accepts BufferSource (ArrayBuffer or any
// ArrayBufferView), and callers throughout this codebase pass both — narrow
// this to just what each function *returns* (always a fresh ArrayBuffer),
// not what it accepts. Pinned to Uint8Array<ArrayBuffer> rather than the bare
// (TS 5.7+ default) Uint8Array<ArrayBufferLike>: BufferSource's ArrayBufferView
// requires a concrete ArrayBuffer, not the wider ArrayBufferLike (which also
// admits SharedArrayBuffer).
type BufferLike = ArrayBuffer | Uint8Array<ArrayBuffer>;

export function sha256(data: BufferLike): Promise<ArrayBuffer> {
    if (!data.byteLength) {
        return Promise.resolve(arrayToBuffer(hexToBytes(EmptySha256)));
    }
    return globalThis.crypto.subtle.digest({ name: 'SHA-256' }, data);
}

export function sha512(data: BufferLike): Promise<ArrayBuffer> {
    if (!data.byteLength) {
        return Promise.resolve(arrayToBuffer(hexToBytes(EmptySha512)));
    }
    return globalThis.crypto.subtle.digest({ name: 'SHA-512' }, data);
}

export function hmacSha256(key: BufferLike, data: BufferLike): Promise<ArrayBuffer> {
    const algo = { name: 'HMAC', hash: { name: 'SHA-256' } };
    return globalThis.crypto.subtle
        .importKey('raw', key, algo, false, ['sign'])
        .then((subtleKey) => {
            return globalThis.crypto.subtle.sign(algo, subtleKey, data);
        });
}

export abstract class AesCbc {
    abstract importKey(key: BufferLike): Promise<void>;
    abstract encrypt(data: BufferLike, iv: BufferLike): Promise<ArrayBuffer>;
    abstract decrypt(data: BufferLike, iv: BufferLike): Promise<ArrayBuffer>;
}

class AesCbcSubtle extends AesCbc {
    private _key: CryptoKey | undefined;

    private get key(): CryptoKey {
        if (!this._key) {
            throw new KdbxError(ErrorCodes.InvalidState, 'no key');
        }
        return this._key;
    }

    importKey(key: BufferLike): Promise<void> {
        return globalThis.crypto.subtle
            .importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt'])
            .then((key) => {
                this._key = key;
            });
    }

    encrypt(data: BufferLike, iv: BufferLike): Promise<ArrayBuffer> {
        return globalThis.crypto.subtle.encrypt(
            { name: 'AES-CBC', iv },
            this.key,
            data
        ) as Promise<ArrayBuffer>;
    }

    decrypt(data: BufferLike, iv: BufferLike): Promise<ArrayBuffer> {
        return globalThis.crypto.subtle.decrypt({ name: 'AES-CBC', iv }, this.key, data).catch(() => {
            throw new KdbxError(ErrorCodes.InvalidKey, 'invalid key');
        }) as Promise<ArrayBuffer>;
    }
}

export function createAesCbc(): AesCbc {
    return new AesCbcSubtle();
}

export function random(len: number): ArrayBuffer {
    const randomBytes = new Uint8Array(len);
    let remaining = len;
    while (remaining > 0) {
        let segmentSize = remaining % MaxRandomQuota;
        segmentSize = segmentSize > 0 ? segmentSize : MaxRandomQuota;
        const randomBytesSegment = new Uint8Array(segmentSize);
        globalThis.crypto.getRandomValues(randomBytesSegment);
        remaining -= segmentSize;
        randomBytes.set(randomBytesSegment, remaining);
    }
    return randomBytes.buffer;
}

export function chacha20(
    data: BufferLike,
    key: BufferLike,
    iv: BufferLike
): Promise<ArrayBuffer> {
    return Promise.resolve().then(() => {
        const algo = new ChaCha20(new Uint8Array(key), new Uint8Array(iv));
        return arrayToBuffer(algo.encrypt(new Uint8Array(data)));
    });
}

export const Argon2TypeArgon2d = 0;
export const Argon2TypeArgon2id = 2;

export type Argon2Type = typeof Argon2TypeArgon2d | typeof Argon2TypeArgon2id;
export type Argon2Version = 0x10 | 0x13;

export type Argon2Fn = (
    password: ArrayBuffer,
    salt: ArrayBuffer,
    memory: number,
    iterations: number,
    length: number,
    parallelism: number,
    type: Argon2Type,
    version: Argon2Version
) => Promise<ArrayBuffer>;

let argon2impl: Argon2Fn | undefined;

export function argon2(
    password: ArrayBuffer,
    salt: ArrayBuffer,
    memory: number,
    iterations: number,
    length: number,
    parallelism: number,
    type: Argon2Type,
    version: Argon2Version
): Promise<ArrayBuffer> {
    if (argon2impl) {
        return argon2impl(
            password,
            salt,
            memory,
            iterations,
            length,
            parallelism,
            type,
            version
        ).then(arrayToBuffer);
    }
    return Promise.reject(new KdbxError(ErrorCodes.NotImplemented, 'argon2 not implemented'));
}

export function setArgon2Impl(impl: Argon2Fn): void {
    argon2impl = impl;
}
