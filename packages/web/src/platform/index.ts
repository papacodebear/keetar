// Platform shim entry point (§9.2). Re-exports the same API surface from
// whichever browser's shim actually applies, detected at runtime rather than
// at build time, since both browsers' shims are trivially small. Statically
// imports both (rather than §9.2's dynamic-import sketch) so the service
// worker bundle doesn't depend on runtime code-splitting working correctly —
// neither shim touches its browser-specific globals at module-evaluation
// time, only inside the functions below, so importing the inapplicable one
// is inert.
//
// Detects on `chrome` vs. `browser` namespace existence rather than gating on
// `chrome.identity` (§9.2's own example) — `chrome.identity` is only defined
// when the "identity" permission is requested, which Phase 2's manifest
// doesn't (no OAuth work until §7.3), so that check would misdetect here.
import * as chromePlatform from './chrome';
import * as firefoxPlatform from './firefox';

const isChrome =
    typeof chrome !== 'undefined' && typeof (globalThis as { browser?: unknown }).browser === 'undefined';

const platform = isChrome ? chromePlatform : firefoxPlatform;

export const { storage, idle, alarms } = platform;
