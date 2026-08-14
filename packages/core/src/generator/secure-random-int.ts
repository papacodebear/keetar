import { random } from '../crypto/crypto-engine.js';

// Rejection-samples a uniform int in [0, maxExclusive) from CSPRNG bytes to avoid modulo bias.
export function secureRandomInt(maxExclusive: number): number {
    if (maxExclusive <= 0) {
        throw new Error('maxExclusive must be positive');
    }
    if (maxExclusive <= 0x100) {
        return rejectionSample(maxExclusive, 1, 0x100);
    }
    if (maxExclusive <= 0x10000) {
        return rejectionSample(maxExclusive, 2, 0x10000);
    }
    throw new Error('maxExclusive too large');
}

function rejectionSample(maxExclusive: number, byteLength: number, rangeSize: number): number {
    const limit = rangeSize - (rangeSize % maxExclusive);
    for (;;) {
        const bytes = new Uint8Array(random(byteLength));
        let value = 0;
        for (const b of bytes) {
            value = (value << 8) | b;
        }
        if (value < limit) {
            return value % maxExclusive;
        }
    }
}
