import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { Argon2Type, Argon2Version } from '../../src/crypto/crypto-engine';

// Load argon2-browser's low-level WASM directly to support raw bytes and version control.
const nodeRequire = createRequire(import.meta.url);

interface Argon2Module {
    allocate(data: ArrayLike<number>, type: 'i8', allocator: number): number;
    ALLOC_NORMAL: number;
    HEAP8: Int8Array;
    _argon2_hash(
        tCost: number,
        mCost: number,
        parallelism: number,
        pwd: number,
        pwdlen: number,
        salt: number,
        saltlen: number,
        hash: number,
        hashlen: number,
        encoded: number,
        encodedlen: number,
        type: Argon2Type,
        version: Argon2Version
    ): number;
    _free(ptr: number): void;
}

let modulePromise: Promise<Argon2Module> | undefined;

function loadArgon2Module(): Promise<Argon2Module> {
    if (!modulePromise) {
        modulePromise = new Promise((resolve) => {
            // Preload .wasm bytes to short-circuit Node 24's fetch sniffing issue.
            const wasmPath = nodeRequire.resolve('argon2-browser/dist/argon2.wasm');
            const wasmBinary = fs.readFileSync(wasmPath);
            const Module: { wasmBinary: Buffer; postRun?: () => void } = {
                wasmBinary,
                postRun: () => resolve(Module as unknown as Argon2Module)
            };
            // Hand config via globalThis.self to match argon2-browser's module scope convention.
            (globalThis as { self?: unknown }).self = { Module };
            nodeRequire('argon2-browser/dist/argon2.js');
        });
    }
    return modulePromise;
}

export async function argon2(
    password: ArrayBuffer,
    salt: ArrayBuffer,
    memory: number,
    iterations: number,
    length: number,
    parallelism: number,
    type: Argon2Type,
    version: Argon2Version
): Promise<ArrayBuffer> {
    const Module = await loadArgon2Module();
    const passwordLen = password.byteLength;
    const passwordPtr = Module.allocate(new Uint8Array(password), 'i8', Module.ALLOC_NORMAL);
    const saltLen = salt.byteLength;
    const saltPtr = Module.allocate(new Uint8Array(salt), 'i8', Module.ALLOC_NORMAL);
    const hashPtr = Module.allocate(new Array(length), 'i8', Module.ALLOC_NORMAL);
    const encodedLen = 512;
    const encodedPtr = Module.allocate(new Array(encodedLen), 'i8', Module.ALLOC_NORMAL);
    try {
        const res = Module._argon2_hash(
            iterations,
            memory,
            parallelism,
            passwordPtr,
            passwordLen,
            saltPtr,
            saltLen,
            hashPtr,
            length,
            encodedPtr,
            encodedLen,
            type,
            version
        );
        if (res) {
            throw new Error(`Argon2 error: ${res}`);
        }
        const hashArr = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            hashArr[i] = Module.HEAP8[hashPtr + i];
        }
        return hashArr.buffer;
    } finally {
        Module._free(passwordPtr);
        Module._free(saltPtr);
        Module._free(hashPtr);
        Module._free(encodedPtr);
    }
}
