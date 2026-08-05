import { CryptoEngine } from '@keetar/core';

// Loads argon2-browser's low-level WASM Module inside the MV3 service worker
// via importScripts() rather than dynamic import(), for CSP compliance
// (§3.1, §11.4) — MV3's default CSP disallows the remote-code patterns
// dynamic import can trigger, but a classic-script importScripts() call
// against a same-origin bundled file is fine.
//
// As in @keetar/core's test harness (packages/core/tests/test-support/argon2.ts),
// this bypasses argon2-browser's public hash() wrapper — it hardcodes Argon2
// version 0x13 and only accepts UTF-8 string input, but real KDBX4 files can
// specify version 0x10 (§3.2) and our composite key/salt are raw bytes — and
// calls the low-level WASM Module directly.
//
// Not yet verified against a live browser session — the WASM-loading
// mechanics here (locateFile override, importScripts timing) are reasoned
// through from the emscripten glue's own source, not observed working.
// Confirm this actually decrypts a real Argon2-KDF .kdbx file before relying
// on it.

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
        modulePromise = new Promise((resolve) => {
            const Module: { locateFile: (path: string) => string; postRun?: () => void } = {
                // background.js and wasm/argon2/ are siblings in the build
                // output (§10.1) — argon2.js resolves argon2.wasm relative to
                // the service worker's own location (self.location.href), not
                // its own importScripts path, so this override is required.
                locateFile: (path) => `wasm/argon2/${path}`,
                postRun: () => resolve(Module as unknown as Argon2Module)
            };
            (self as unknown as { Module: unknown }).Module = Module;
            importScripts('wasm/argon2/argon2.js');
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
