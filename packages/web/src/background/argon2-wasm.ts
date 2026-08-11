import { CryptoEngine } from '@keetar/core';

// Load argon2-browser's WASM Module via importScripts (Chrome MV3) or <script> (Firefox MV2).
// Calls low-level Module directly to support Argon2 v0x10 and raw bytes (not UTF-8 strings).

declare function importScripts(...urls: string[]): void;

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
        type: number,
        version: number
    ): number;
    _free(ptr: number): void;
}

let modulePromise: Promise<Argon2Module> | undefined;

function loadArgon2Module(): Promise<Argon2Module> {
    if (!modulePromise) {
        modulePromise = new Promise((resolve, reject) => {
            const Module: { locateFile: (path: string) => string; postRun?: () => void } = {
                // Use chrome.runtime.getURL for origin-rooted path (works from any caller).
                locateFile: (path) => chrome.runtime.getURL(`wasm/argon2/${path}`),
                postRun: () => resolve(Module as unknown as Argon2Module)
            };
            (self as unknown as { Module: unknown }).Module = Module;
            const scriptUrl = chrome.runtime.getURL('wasm/argon2/argon2.js');
            if (typeof importScripts === 'function') {
                importScripts(scriptUrl);
            } else {
                const script = document.createElement('script');
                script.src = scriptUrl;
                script.onerror = () => reject(new Error('failed to load argon2.js'));
                document.head.appendChild(script);
            }
        });
    }
    return modulePromise;
}

/** Wires the real WASM Argon2 implementation into @keetar/core's pluggable interface. */
export function installArgon2(): void {
    CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
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
    });
}
