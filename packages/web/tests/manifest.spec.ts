import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// externally_connectable would let arbitrary web pages message the background directly — Keetar
// relies on its absence so only the extension's own content script (never page JS) can reach
// GET_ENTRY_FIELD / FILL_PAGE_ENTRY (§ Options item 10 — cross-site entry isolation).
const manifestsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../manifests');

describe('manifests never declare externally_connectable', () => {
    for (const file of ['manifest.chrome.json', 'manifest.firefox.json']) {
        test(file, () => {
            const manifest = JSON.parse(readFileSync(path.join(manifestsDir, file), 'utf8'));
            expect(manifest.externally_connectable).toBeUndefined();
        });
    }
});
