# Keetar — Browser Extension Architecture & Implementation Plan

> Claude Code planning document. Read this before writing any code. Every architectural decision made in this document has a reason — if something seems wrong, check the reasoning before changing it.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Project Identity & Repository Structure](#2-project-identity--repository-structure)
3. [Cryptography Engine](#3-cryptography-engine)
4. [Local Storage: OPFS Cache & File System Access API](#4-local-storage-opfs-cache--file-system-access-api)
5. [Autofill System](#5-autofill-system)
6. [Authentication & Biometric Unlock](#6-authentication--biometric-unlock)
7. [Storage Backends](#7-storage-backends)
8. [Extension UI Architecture](#8-extension-ui-architecture)
9. [Chrome MV3 / Firefox Compatibility](#9-chrome-mv3--firefox-compatibility)
10. [Build System & Testing](#10-build-system--testing)
11. [Security Model & Threat Mitigations](#11-security-model--threat-mitigations)
12. [Implementation Phases](#12-implementation-phases)
13. [Dependencies & Rationale](#13-dependencies--rationale)
14. [Open Decisions for Implementation](#14-open-decisions-for-implementation)

---

## 1. Project Overview

A standalone browser extension (Chrome + Firefox) that reads and writes KeePass KDBX databases with no native desktop app dependency. All cryptography runs in the extension's background service worker using the Web Crypto API and audited WASM libraries. The extension replicates all browser-relevant KeePassXC features and surpasses the current KeePassXC-Browser integration in several areas — notably TOTP generation, passkey storage, and cloud sync — by removing the requirement for a local app.

### 1.1 Primary Goals

- Full KDBX4 read/write parity — databases must remain compatible with KeePassXC desktop
- Written in TypeScript throughout, both packages — strict typing across `@keetar/core` and `@keetar/web` (§2.5)
- **Launch first** with a local-file backend (File System Access API) so users can bring a vault they already sync themselves — via a Dropbox/Google Drive/OneDrive desktop client, or any other means — with zero OAuth complexity
- **Follow with** native cloud sync (Google Drive, Dropbox, OneDrive) via direct OAuth once the local-file path is stable — this remains a primary long-term goal, just sequenced after launch rather than in it (see [§7](#7-storage-backends))
- Security level equal to or better than KeePassXC: Argon2id KDF, AES-256, ChaCha20, HMAC-SHA256 integrity
- Biometric unlock via WebAuthn PRF (Face ID, Touch ID, Windows Hello, FIDO2 hardware keys)
- Browser autofill, TOTP generation, password health, HIBP breach checking — all without a companion app
- Chrome MV3 and Firefox MV2/MV3 compatible from a single codebase

> **KDBX3 is out of scope**, not just deprioritized. Only KDBX4 is supported for read and write. KeePassXC has defaulted to KDBX4 for new databases for years; a user still on a KDBX3 database can upgrade it via KeePassXC desktop before pointing this extension at it. See §3.2 for how an unsupported version is surfaced.

### 1.2 Non-Goals (by design)

These are hard browser sandbox limits, not implementation gaps. Document them in the extension README.

| Feature | Why impossible |
|---|---|
| SSH agent integration | Requires OS-level Unix socket / named pipe — inaccessible from browser |
| FreeDesktop Secret Service | D-Bus IPC — Linux-only OS primitive, no browser API |
| Auto-Type into native desktop apps | Requires OS keyboard injection (xdotool, Win32 SendInput, AppleScript) |
| keepassxc-cli equivalent | No browser analogue for a command-line interface |
| Auto-Open databases on startup | Requires filesystem event watching — no browser equivalent |

### 1.3 Deferred, Not Non-Goals

Unlike §1.2, these are things we intend to build — just not at launch:

| Feature | Status |
|---|---|
| Direct cloud OAuth (Google Drive, Dropbox, OneDrive) | Deferred to a post-launch phase. See [§7.3](#73-deferred-direct-cloud-oauth). |
| iCloud / WebDAV (Nextcloud, Synology, etc.) | Skipped for now, no committed phase. See [§7.4](#74-skipped-for-now-icloud--webdav). |
| Passkey storage as a WebAuthn relying party | Open decision, see [§14](#14-open-decisions-for-implementation). |

### 1.4 Where This Extension Beats KeePassXC-Browser

The existing KeePassXC-Browser extension requires a running KeePassXC desktop app and communicates via a local socket. This extension eliminates that dependency entirely and gains:

- TOTP generated natively (no round-trip to desktop app)
- Passkeys stored and served without desktop app
- A synced vault usable immediately via the local-file backend, with direct cloud sync to follow (no permanent "sync folder" workaround)
- Biometric unlock without desktop app running

---

## 2. Project Identity & Repository Structure

### 2.1 Name: Keetar

The project is named **Keetar**. The name is clean across npm, GitHub, and browser extension stores.

### 2.2 npm Packages

| Package | Description |
|---|---|
| `@keetar/core` | A TypeScript-native, isomorphic KDBX4 library — parsing, crypto, and vault management for KeePass-compatible databases. No browser or extension APIs; runs and tests in Node. |
| `@keetar/web` | A browser extension that brings native KeePass vault management to Chrome and Firefox — no desktop app required. |

The `@keetar` npm scope is available. Register the `keetar` npm account to claim it.

### 2.3 GitHub Repository

Single repository named **`keetar`**, description:

> A TypeScript-native KDBX4 library and KeePass-compatible browser extension. No desktop app required.

### 2.4 Repository Structure

Monorepo using pnpm workspaces (Turborepo optional, add if build caching becomes necessary):

```
keetar/
├── packages/
│   ├── core/                          # @keetar/core — isomorphic, no browser APIs
│   │   ├── src/
│   │   │   ├── crypto/                # Bootstrapped from keewebx (§2.7); no platform-crypto
│   │   │   │   │                      # indirection — calls globalThis.crypto.subtle directly,
│   │   │   │   │                      # since the Node 24+ floor (§2.5) guarantees it unconditionally.
│   │   │   │   ├── crypto-engine.ts   # sha256/sha512/hmacSha256/AesCbc/random + pluggable argon2()
│   │   │   │   ├── chacha20.ts        # ChaCha20 stream cipher — wraps @stablelib/chacha (audited);
│   │   │   │   │                      # keewebx's own hand-rolled implementation was swapped out
│   │   │   │   ├── hmac-block-transform.ts  # Per-1MB-block HMAC-SHA256 authentication (§3.2 step 9)
│   │   │   │   ├── key-encryptor-aes.ts     # AES-KDF key transform
│   │   │   │   ├── key-encryptor-kdf.ts     # KDF dispatch: Argon2d / Argon2id / AES-KDF
│   │   │   │   ├── protect-salt-generator.ts # ChaCha20-based inner-stream salt generator
│   │   │   │   └── protected-value.ts       # XOR-in-memory protected-value wrapper (§11.1)
│   │   │   ├── defs/
│   │   │   │   ├── consts.ts          # Signatures, ErrorCodes, CipherId, KdfId, CrsAlgorithm, etc.
│   │   │   │   └── xml-names.ts       # KDBX XML element/attribute name constants
│   │   │   ├── errors/
│   │   │   │   └── kdbx-error.ts      # KdbxError
│   │   │   ├── kdbx/                  # Per-object-model split, adopted from keewebx (§2.7) instead
│   │   │   │   │                      # of the pipeline-stage split (parser.ts/writer.ts/header.ts)
│   │   │   │   │                      # originally sketched here — already proven, more maintainable.
│   │   │   │   ├── kdbx.ts            # Top-level vault class: load/save orchestration, tree ops
│   │   │   │   ├── kdbx-format.ts     # Binary read/write pipeline; explicitly rejects KDBX3 on
│   │   │   │   │                      # both load() and save() (§3.2 step 2, §2.7 fix)
│   │   │   │   ├── kdbx-header.ts     # Header parsing: magic, version, cipher, KDF params
│   │   │   │   ├── kdbx-context.ts    # Per-operation context threaded through the format layer
│   │   │   │   ├── kdbx-credentials.ts    # Master password / key file / challenge-response
│   │   │   │   ├── kdbx-custom-data.ts    # Custom data map (meta + per-entry/group)
│   │   │   │   ├── kdbx-deleted-object.ts # Deleted-object tombstone records
│   │   │   │   ├── kdbx-entry.ts      # Entry model: fields, history, auto-type, attachments
│   │   │   │   ├── kdbx-group.ts      # Group model: hierarchy, entries
│   │   │   │   ├── kdbx-meta.ts       # Database meta: name, icons, recycle bin, memory protection
│   │   │   │   ├── kdbx-times.ts      # Creation/modification/access timestamps
│   │   │   │   └── kdbx-uuid.ts       # KDBX UUID type (16 bytes, base64-encoded)
│   │   │   ├── utils/
│   │   │   │   ├── binary-stream.ts   # Little-endian binary reader/writer over ArrayBuffer
│   │   │   │   ├── byte-utils.ts      # Byte/base64/hex/UTF-8 conversion helpers
│   │   │   │   ├── int64.ts           # 64-bit integer type (KDBX timestamps use this)
│   │   │   │   ├── var-dictionary.ts  # KDBX's VarDictionary format (KDF param serialization)
│   │   │   │   └── xml-utils.ts       # KDBX XML parse/serialize, protected-value XOR pass
│   │   │   ├── auth/
│   │   │   │   └── session-key.ts     # Generic AES-KW wrap/unwrap of raw key material, given VUK
│   │   │   │                          # bytes. Wraps KdbxCredentials.passwordHash (SHA-256 of the
│   │   │   │                          # master password, already a fixed 32 bytes — a public,
│   │   │   │                          # settable field getHash() reads without ever touching the
│   │   │   │                          # live password string) — not the post-Argon2 derived cipher
│   │   │   │                          # key as earlier drafts of this doc said. See §6.2's note for
│   │   │   │                          # why: reusing the derived key to skip Argon2 on reopen would
│   │   │   │                          # need a new entry point into kdbx-format.ts's private,
│   │   │   │                          # security-critical decrypt pipeline, unverifiable against
│   │   │   │                          # real WebAuthn hardware from here — wrapping the password
│   │   │   │                          # hash instead needs zero core changes, Kdbx.load() runs
│   │   │   │                          # completely unmodified, and saving afterward isn't a special
│   │   │   │                          # case since real credentials exist the whole time.
│   │   │   ├── providers/
│   │   │   │   └── file-provider.ts   # FileProvider interface (type only, no implementation)
│   │   │   ├── generator/
│   │   │   │   ├── password.ts        # Character-set based password generator
│   │   │   │   └── passphrase.ts      # Wordlist-based passphrase generator (EFF large list)
│   │   │   ├── totp/
│   │   │   │   └── totp.ts            # RFC 6238 TOTP — pure logic, given the secret
│   │   │   ├── health/
│   │   │   │   ├── hibp.ts            # k-anonymity HIBP client (mockable fetch)
│   │   │   │   └── analyser.ts        # Weak / reused / old / breached report generation
│   │   │   └── import/
│   │   │       ├── types.ts           # VaultEntryRecord — generic shape every importer
│   │   │       │                      # produces and both exporters consume; only
│   │   │       │                      # vault-session.ts (§9) turns it into real
│   │   │       │                      # KdbxEntry/KdbxGroup objects, so parsing/
│   │   │       │                      # serializing here needs no live Kdbx instance
│   │   │       ├── csv.ts             # Generic CSV + KeePass CSV format (import AND
│   │   │       │                      # export — same header shape both ways)
│   │   │       ├── bitwarden.ts       # Bitwarden JSON export format
│   │   │       ├── onepassword.ts     # 1Password 1PUX format — a zip archive, not
│   │   │       │                      # plain JSON; parsed with fflate's unzipSync
│   │   │       │                      # (already a dependency for KDBX's own gzip
│   │   │       │                      # framing, §3.1 — no new dependency needed)
│   │   │       ├── protonpass.ts      # Proton Pass JSON export format
│   │   │       └── export.ts          # exportToCsv/exportToXml — the "Export to CSV
│   │   │                              # and XML" half of §9, not in the original plan's
│   │   │                              # file list but symmetric with the import/ dir,
│   │   │                              # so it lives alongside rather than in a new
│   │   │                              # top-level export/ directory
│   │   ├── tests/
│   │   ├── package.json               # @keetar/core
│   │   └── tsconfig.json
│   │
│   └── web/                            # @keetar/web — everything touching chrome.*/browser APIs
│       ├── src/
│       │   ├── background/
│       │   │   ├── index.ts           # Entry point — registers listeners, initialises session
│       │   │   ├── vault-session.ts   # In-memory decrypted vault state + lock logic
│       │   │   ├── keepalive.ts       # Chrome MV3 service worker keepalive (alarm ping)
│       │   │   ├── message-bus.ts     # Typed message router between popup/manager/content/background.
│       │   │                          # chrome.runtime.sendMessage's documented contract is a
│       │   │                          # JSON-ifiable payload — ArrayBuffer isn't one (serializes to
│       │   │                          # "{}"). Attachment bytes (Manager, §8.2) cross as base64
│       │   │                          # strings instead, via @keetar/core's ByteUtils codecs.
│       │   │   ├── argon2-wasm.ts     # Wires argon2-browser's WASM Module into CryptoEngine (§3.1, §11.4)
│       │   │   ├── dedup.ts           # Combine-vaults duplicate detection (§9 addendum) — username +
│       │   │                          # URL-domain-label matching via tldts, the same dependency
│       │   │                          # autofill/matcher.ts uses. Lives here, not in @keetar/core,
│       │   │                          # for the same reason matcher.ts does: tldts is a @keetar/web-
│       │   │                          # only dependency, not one @keetar/core carries. Also owns the
│       │   │                          # additive per-field merge rules (mergeStringField/mergeIcon) —
│       │   │                          # pure functions, kept testable and separate from
│       │   │                          # vault-session.ts's mergeRecordIntoEntry, which is the only
│       │   │                          # part that actually touches a live KdbxEntry.
│       │   │   └── favicon.ts         # On-demand favicon → custom icon (§9 addendum follow-up) —
│       │   │                          # fetch() + createImageBitmap() + OffscreenCanvas, all
│       │   │                          # available in a Chrome MV3 service worker (unlike `document`),
│       │   │                          # so this needs no page/content-script round trip.
│       │   ├── providers/
│       │   │   ├── index.ts           # createFileProvider(vault) — the one place a
│       │   │   │                      # ConfiguredVault.provider string maps to a concrete
│       │   │   │                      # FileProvider (§7.1); vault-session.ts's only import
│       │   │   │                      # from providers/, staying provider-agnostic itself
│       │   │   ├── local-file.ts      # File System Access API — primary backend, ships first.
│       │   │   │                      # pickVaultFile() opens an existing file; createVaultFile()
│       │   │   │                      # (chat-requested addition) saves a brand-new one via
│       │   │   │                      # showSaveFilePicker() instead of showOpenFilePicker()
│       │   │   ├── vault-creation.ts  # createEmptyVaultBytes(name, password) — Kdbx.create()
│       │   │   │                      # + save(), backend-agnostic (chat-requested addition;
│       │   │   │                      # vault *creation* didn't exist for any backend before
│       │   │   │                      # this, including local-file, which only ever opened an
│       │   │   │                      # existing file)
│       │   │   ├── opfs-cache.ts      # §4.3's sync algorithm, as a decorator (OpfsCachedProvider)
│       │   │   │                      # wrapping any cloud FileProvider — provider-agnostic,
│       │   │   │                      # not part of gdrive.ts itself, so dropbox.ts/onedrive.ts
│       │   │   │                      # get it for free later. See §4.3's own writeup for the
│       │   │   │                      # read()/write()/conflict-resolution behavior
│       │   │   ├── oauth-pkce.ts      # Provider-agnostic PKCE OAuth2 (§7.3) — authorize()/
│       │   │   │                      # refreshAccessToken(), shared by every cloud provider,
│       │   │   │                      # not one flow per provider. Pure code_verifier/
│       │   │   │                      # code_challenge generation is unit-tested against
│       │   │   │                      # RFC 7636's own Appendix B vector (§10.2)
│       │   │   ├── oauth-token-store.ts  # Encrypted OPFS token storage (§4.1, §7.3) — one
│       │   │   │                      # record per provider via storage/device-secret.ts
│       │   │   ├── gdrive.ts          # Built (Phase 10) — Google Drive via Drive REST API v3,
│       │   │   │                      # launchWebAuthFlow/PKCE (§7.3). GOOGLE_CLIENT_ID /
│       │   │   │                      # GOOGLE_PICKER_API_KEY are placeholders until §7.3's
│       │   │   │                      # Google Cloud Console setup walkthrough is done by hand.
│       │   │   │                      # forceWrite() bypasses its own session-scoped revision
│       │   │   │                      # guard — opfs-cache.ts's conflict resolution needs that
│       │   │   │                      # for "keep local," deliberately overwriting the cloud copy
│       │   │   ├── gdrive-picker.ts   # Thin wrapper: PickerBuilder config (DocsView, OAuth
│       │   │   │                      # token, developer key, callback) around
│       │   │   │                      # google-picker-offline-loader's loadGooglePicker()
│       │   │   │                      # (§7.3, §11.4, §13) — an extracted, standalone npm
│       │   │   │                      # package (github.com/papacodebear/
│       │   │   │                      # google-picker-offline-loader) that owns the actual
│       │   │   │                      # vendoring/DOM-interception mechanism (originally built
│       │   │   │                      # and validated here, then pulled out once it became
│       │   │   │                      # clear it's a generically useful, Keetar-independent
│       │   │   │                      # problem — see that package's own README for the
│       │   │   │                      # mechanism details this file used to carry inline)
│       │   │   ├── dropbox.ts         # Deferred — Dropbox OAuth2 + Dropbox API v2. oauth-pkce.ts
│       │   │   │                      # should cover the OAuth half unmodified when this starts
│       │   │   └── onedrive.ts        # Deferred — OneDrive OAuth2 + MS Graph API
│       │   ├── auth/
│       │   │   ├── webauthn.ts        # WebAuthn credential registration + assertion
│       │   │   ├── prf.ts             # PRF extension — derive VUK from authenticator output
│       │   │   ├── biometric.ts       # Enrol + unlock flow orchestration
│       │   │   └── biometric-store.ts # Per-vault { credentialId, prfSalt, wrappedPasswordHash,
│       │   │                          # enrolledAt } record in real OPFS (§4.1) — unlike
│       │   │                          # local-file.ts's handle store (IndexedDB, forced by
│       │   │                          # FileSystemFileHandle not being JSON-serializable), this
│       │   │                          # data has no such constraint, so it follows §4.1 as written.
│       │   │                          # OPFS needs no user gesture, reachable from both background
│       │   │                          # and pages — unlock (background) and enrollment (Options)
│       │   │                          # both use this unmodified.
│       │   ├── autofill/
│       │   │   ├── content.ts         # Content script: detect login forms, receive fill msg
│       │   │   ├── detector.ts        # DOM heuristics for username/password field pairs
│       │   │   ├── filler.ts          # Credential injection compatible with React/Vue/Angular
│       │   │   ├── matcher.ts         # Domain matching: exact → hostname → base domain → title
│       │   │   └── messages.ts        # FillCredentialsMessage — Popup → content script, direct
│       │   │                          # via chrome.tabs.sendMessage, not background's message-bus.ts
│       │   ├── ui/
│       │   │   ├── popup/             # Quick-access UI, post-unlock — see §8
│       │   │   │   ├── index.tsx      # Webpack entry — mounts <App /> into #root
│       │   │   │   ├── App.tsx        # Locked/unlocked view state machine
│       │   │   │   └── popup.html
│       │   │   ├── manager/           # Vault-content management UI, post-unlock only — see §8
│       │   │   │   ├── index.tsx      # Webpack entry — mounts <App /> into #root
│       │   │   │   ├── App.tsx        # Group tree + entry list + entry edit/attachments panel +
│       │   │   │   │                  # import/export panel (§9)
│       │   │   │   └── manager.html
│       │   │   ├── options/           # Setup + config, reachable pre-unlock — see §8
│       │   │   │   ├── index.tsx      # Webpack entry — mounts <App /> into #root
│       │   │   │   ├── App.tsx        # Vault file selection, biometric enrollment, Google
│       │   │   │   │                  # Drive connect/pick (§7.3, §10), vault creation on
│       │   │   │   │                  # either backend, §4.3 sync-conflict resolution
│       │   │   │   └── options.html   # Replaced src/dev-harness/ (Phase 2's stand-in for
│       │   │   │                      # exactly this — file selection) once this became real
│       │   │   └── shared/
│       │   │       └── EntryIcon.tsx  # Entry icon rendering (§9 addendum) — shared by Popup and
│       │   │                          # Manager's entry rows, so it's under ui/shared/ rather
│       │   │                          # than either page's own directory. Two sources: the
│       │   │                          # built-in index (a static asset lookup, icons/{n}.png —
│       │   │                          # see assets/icons/ — with an onError fallback for any
│       │   │                          # index whose file hasn't been sourced), or a custom icon
│       │   │                          # (real vault data, fetched on demand via
│       │   │                          # GET_ENTRY_CUSTOM_ICON, same reasoning as attachments).
│       │   ├── platform/
│       │   │   ├── chrome.ts          # Chrome-specific: MV3 service worker, chrome.identity
│       │   │   │                      # (§9.2, §7.3 — launchWebAuthFlow/getRedirectURL, added
│       │   │   │                      # Phase 10; the "identity" permission it needs wasn't
│       │   │   │                      # requested by any manifest before this phase). Also
│       │   │   │                      # `action` (§5.1's toolbar badge, §9.1/§12 Phase 11) —
│       │   │   │                      # found missing by web-ext lint against the Firefox
│       │   │   │                      # build: background/index.ts called chrome.action
│       │   │   │                      # directly instead of going through this shim
│       │   │   ├── firefox.ts         # Firefox-specific: MV2 background page, browser.identity,
│       │   │   │                      # browser.browserAction (MV2's name for `action`)
│       │   │   └── index.ts           # Re-exports correct shim based on build target
│       │   ├── storage/
│       │   │   └── device-secret.ts   # Device-local AES-256-GCM at-rest encryption (§4.1, §7.3),
│       │   │                          # new in Phase 10 — protects OAuth tokens
│       │   │                          # (oauth-token-store.ts) now, key files later (§4.1's
│       │   │                          # own /keyfile-<uuid>.bin row predates this but nothing
│       │   │                          # had built the encryption layer it depends on until now)
│       │   └── config/
│       │       └── vault-config.ts    # Configured-vault storage key/shape — shared between
│       │                              # Options (owns file/provider selection, §8.2) and Popup
│       │                              # (needs the uuid to send with UNLOCK_VAULT), so it
│       │                              # exists in one place. ConfiguredVault gained `provider`
│       │                              # and `path` fields in Phase 10 — previously implicitly
│       │                              # always local-file, now explicit now that gdrive.ts
│       │                              # exists as a second backend
│       ├── manifests/
│       │   ├── manifest.chrome.json   # MV3. Gained the "identity" permission in Phase 10
│       │   │                          # (§7.3). Briefly also gained `sandbox.pages` and a
│       │   │                          # `content_security_policy.sandbox` override for the
│       │   │                          # Google Picker bridge, removed again once the Picker's
│       │   │                          # JS was vendored (first locally, now via
│       │   │                          # google-picker-offline-loader — §7.3, §11.4, §13)
│       │   │                          # instead of loaded live. No custom CSP at all now; the
│       │   │                          # default (script-src 'self') already permits it
│       │   └── manifest.firefox.json  # MV2 — built in Phase 11 (§9.4, §12). No MV3 Firefox
│       │                              # variant: §9.1/§9.4 already specify MV2 for Firefox,
│       │                              # and nothing in this project's scope needs Firefox's
│       │                              # newer, optional MV3 support specifically. Never had a
│       │                              # sandbox/CSP entry to remove — vendoring meant Firefox
│       │                              # never needed one to begin with, unlike Chrome's brief
│       │                              # detour through the sandboxed-page approach
│       ├── assets/
│       │   └── icons/                 # Built-in KeePass icon set (§9 addendum), sourced by hand —
│       │                              # see this directory's own README.md for the naming
│       │                              # convention (index.png, matching Consts.Icons) and the
│       │                              # full index→name table. Not vendored from anywhere; no
│       │                              # image set ships with @keetar/core or keewebx (§2.7).
│       │                              # Doesn't need to be complete, or even present, for the
│       │                              # build to succeed (webpack.config.js's copy pattern below).
│       ├── build/
│       │   └── webpack.config.js      # copies argon2-browser's dist/argon2.{js,wasm} from
│       │                              # node_modules into dist/<target>/wasm/argon2/ at build
│       │                              # time (§10.1) — not vendored in the source tree. A
│       │                              # vendored copy could silently drift from whatever
│       │                              # version package.json/pnpm-lock.yaml actually pin;
│       │                              # copying from the resolved dependency at build time
│       │                              # can't. Also copies assets/icons/*.png → dist/<target>/icons/,
│       │                              # with noErrorOnMissing — an incomplete or empty icon set
│       │                              # doesn't fail the build, only leaves EntryIcon.tsx's
│       │                              # runtime fallback doing more of the work. And copies
│       │                              # google-picker-offline-loader's node_modules/…/vendor/
│       │                              # *.js verbatim (§7.3, §11.4, §13) — with an explicit
│       │                              # TerserPlugin `exclude` pattern so webpack's default
│       │                              # production minifier never touches them: the whole
│       │                              # point of that package's own capture/validate step is
│       │                              # that *these exact bytes* were proven to work against
│       │                              # Google's live Picker; re-minifying at build time would
│       │                              # silently ship different bytes than what was ever
│       │                              # actually validated. Found by comparing checksums after
│       │                              # the first build, not assumed — re-verified after the
│       │                              # vendoring mechanism moved into its own package.
│       ├── tests/
│       ├── package.json               # @keetar/web
│       └── tsconfig.json
│
├── package.json                       # workspace root
├── tsconfig.json                      # base config, extended by packages
├── pnpm-workspace.yaml                # allowBuilds carries one explicit entry beyond esbuild's
│                                       # default: google-picker-offline-loader (§7.3, §11.4, §13),
│                                       # a git dependency with a `prepare` build script — pnpm
│                                       # blocks build scripts from any package (git-hosted or
│                                       # not) unless allowlisted here, on the reasonable premise
│                                       # that an arbitrary transitive dependency's install-time
│                                       # script is a real supply-chain risk. Allowlisted after
│                                       # reviewing what it actually runs (`tsc`, nothing else).
└── ARCHITECTURE.md
```

### 2.5 Package Boundary: What Goes in @keetar/core

`@keetar/core` must be isomorphic — no browser APIs, no extension APIs, testable in Node. It owns:

**KDBX format:** File parsing and serialization (KDBX4 only, §1.1), header/inner header/payload decryption, XML layer (entry/group tree, custom fields, history, recycle bin), file writing with correct HMAC blocks.

**Crypto:** Argon2id and AES-KDF key derivation, AES-256-CBC and ChaCha20 payload decryption, ChaCha20 protected field decryption, HMAC-SHA256 block authentication, random credential generation, AES-KW session-key wrap/unwrap.

**Vault data model:** Entry, Group, Attachment, CustomField types, search and filtering, TOTP generation (pure logic — given the secret), password strength estimation, history management, merge logic.

**Key sources (abstract):** Master password processing, key file parsing, WebAuthn PRF key material ingestion. Core handles what to *do* with PRF output (wrap/unwrap the session key) — not how to obtain it. The WebAuthn ceremony itself (`navigator.credentials.*`) is a browser API and stays in `@keetar/web`.

**Storage contract:** `providers/file-provider.ts` exports the `FileProvider` interface as a type only (§7.1). Other consumers of `@keetar/core` — a Node CLI, a future desktop app — can implement it against their own storage without pulling in any extension code.

**Crypto abstraction boundary:** superseded by §2.7's bootstrap — `crypto-engine.ts` calls `globalThis.crypto.subtle` directly rather than through an injected `platform-crypto.ts` interface (keewebx's own pattern, adopted as-is per §2.7 point 5). No indirection needed: the Node 24+ floor above guarantees `globalThis.crypto.subtle` unconditionally, so the same code path — no browser-vs-Node branch — runs in both `@keetar/web` and core's Node test suite.

**Node floor: 24+.** `globalThis.crypto.subtle` has been available since Node 19, so no polyfill is needed at any currently-maintained LTS — 24 is chosen for support-policy freshness, not a capability gap. It's the current Active LTS (EOL 2028-04-30), giving the longest runway of any maintained line before this needs revisiting. Node 22 (Maintenance LTS, EOL 2027-04-30) and Node 20 (EOL 2026-04-30, already past) were both considered; Node 18 (EOL 2025-04-30) was rejected outright as already dead for over a year. Set `"engines": { "node": ">=24" }` in both packages' `package.json` (§2.4).

`@keetar/web` owns everything touching `chrome.*` APIs, the File System Access API, OPFS, the WebAuthn ceremony, UI, content scripts, the service worker, and cloud provider HTTP calls.

### 2.6 Community Library Angle

`@keetar/core` is designed to be consumed independently by the broader KeePass/JS ecosystem. `kdbxweb`, the most established prior art, hasn't published to npm since September 2021. A well-maintained, TypeScript-native, isomorphic KDBX4-complete parsing library with a clean API would be the de facto JS KDBX library. Treat its public API and documentation accordingly — this is the reason the core/web boundary in §2.5 is enforced strictly rather than treated as a soft convention.

### 2.7 Bootstrapping @keetar/core from keewebx/packages/db

Rather than writing the KDBX4 parser/crypto/model layer from scratch, `@keetar/core`'s `kdbx/` and `crypto/` directories start as a plain-copy fork of [gynet/keewebx](https://github.com/gynet/keewebx)'s `packages/db` (MIT-licensed, itself a fork of Antelle's `kdbxweb`). It isn't published to npm (`"private": true` in its `package.json`), so this is a source copy, not a dependency.

**Mechanics:**
- Plain copy, not a history-preserving `git subtree`/`filter-repo` merge — most of it gets restructured on import anyway (see below), so preserving blame history has little payoff here.
- License obligation: MIT. Carry forward the attribution chain their own `package.json` already documents — Antelle (original `kdbxweb` author) → gynet/keewebx (this fork) → Keetar — in a `NOTICE` file and in `@keetar/core`'s `package.json` `contributors` field. Confirmed present: `packages/db/LICENSE` at the keewebx repo root (Copyright (C) 2021-2025 Antelle, MIT), consistent with the `package.json` `"license": "MIT"` field. Both are now carried forward in `@keetar/core`'s `NOTICE` and `package.json`.

**What to pull in, in priority order:**

1. **`lib/utils/`** (`binary-stream.ts`, `byte-utils.ts`, `int64.ts`, `var-dictionary.ts`, `xml-utils.ts`) — binary/varint plumbing (KDBX's `VarDictionary` format for KDF params, int64 handling). Highest value, lowest risk: no product judgment involved, fully unit-tested, exactly the code not worth re-debugging from scratch.
2. **`lib/format/` + `lib/crypto/`** — the parser/writer/crypto engine itself. Their format layer is split per object model (`kdbx-entry.ts`, `kdbx-group.ts`, `kdbx-meta.ts`, `kdbx-header.ts`, etc.) rather than the per-pipeline-stage split originally drawn in §2.4's tree (`parser.ts`/`writer.ts`/`header.ts`). **Adopt their per-object-model split instead** — it's already proven and more maintainable. Update §2.4's `kdbx/` listing to match once this work starts.
3. **`protected-value.ts`** — the XOR-in-memory protected-value wrapper. §11.1 assumes this property (decrypted data never written to storage in plaintext) but §2.4 hadn't designed it as its own primitive. Take as-is.
4. **The whole `test/` directory** (~548K, real binary `.kdbx` fixtures — KeePassXC-generated, pykeepass-generated, deliberately-broken files like `broken_kdbx_version.kdbx`). Directly satisfies §10.2's "test against real KeePassXC output" requirement, and is better coverage than fixtures built from scratch.
5. **Their crypto abstraction pattern** — feature-detect `globalThis.crypto?.subtle` with a `node:crypto` fallback inside the same function, rather than an injected interface. Simpler than the `platform-crypto.ts` design in §2.5/§3.1 — adopt this pattern instead when the crypto module is written. **Strip the `node:crypto` fallback branches on import.** Their code carries that fallback because `packages/db` pins `"node": "^18.18.0"` — Node 18 doesn't guarantee global WebCrypto, so the fallback is load-bearing for them. Our Node 24+ floor (§2.5) guarantees `globalThis.crypto.subtle` unconditionally, so the fallback branch would be unreachable dead code — deleting it also directly contradicts nothing, since we never claimed Node 18 compatibility to begin with. Each function in their `crypto-engine.ts` (`sha256`, `sha512`, `hmacSha256`, etc.) becomes a straight `globalThis.crypto.subtle` call with the `if (globalThis.crypto?.subtle) { … } else { … }` branch and its `nodeCrypto` import removed.

**Fixes required on import — don't carry these bugs forward:**
- **KDBX3 read-path gap:** their header parser still sets `MinSupportedVersion: 3`, and the KDBX3 inner-stream cipher (Salsa20) has no implementation (`CrsAlgorithm.Salsa20` is declared but unhandled in `protect-salt-generator.ts`) — so a KDBX3 file fails confusingly mid-decrypt instead of being rejected cleanly on open. Only their `save()` (write) path explicitly rejects it. Add the same explicit rejection to the read path per §3.2 step 2. Their own `test_db_kdbx3_with_chacha20_protected_fields.kdbx` fixture becomes our negative "reject cleanly" test case instead of a positive-support case.
- **Twofish cipher:** their fixtures include `test_db_kdbx4_with_password_argon2_twofish.kdbx` — Twofish is a real KDBX4 cipher option §3.2 doesn't currently mention (it only lists AES-256/ChaCha20 as cipher UUID options). Decide whether to support it or explicitly reject it with a clear error — don't leave it unhandled by accident.

**Bootstrap status (initial import):** Both fixes above were re-verified against the actual keewebx source at import time, not assumed from this document:
- **KDBX3:** the read-path gap was real — `kdbx-header.ts`'s `readVersion()` had `MinSupportedVersion: 3`. Fixed by raising it to 4, so an unsupported version (including KDBX3) is now rejected in `KdbxHeader.read()` itself, before any downstream cipher-selection code runs — with a message naming the version found. Separately, `kdbx-format.ts`'s `load()`/`save()` *already* had their own explicit `versionMajor === 3` check with a clear "KDBX3 is not supported" message — apparently fixed upstream in keewebx after this document's original review. Both checks now exist; harmless redundancy, not a conflict.
- **Twofish:** already cleanly rejected — `CipherId` in `defs/consts.ts` only defines `Aes`/`ChaCha20`, so an unrecognized cipher UUID (Twofish included) falls to the `default` case in `kdbx-format.ts`'s cipher dispatch and rejects with `ErrorCodes.Unsupported`. No support was added; decision was to keep it explicitly unsupported, matching §3.2's AES-256/ChaCha20-only cipher list.
- **ChaCha20 implementation:** not listed as a required fix above, but discovered during bootstrap — keewebx's `chacha20.ts` is a hand-rolled implementation, not the `@stablelib/chacha` library §3.1 specifies for this security-critical module. Swapped it for a `@stablelib/chacha`-backed wrapper preserving the same class interface (`getBytes()`/`encrypt()`), so `protect-salt-generator.ts` and `crypto-engine.ts` needed no changes. Verified bit-identical output against the original implementation's own test vectors before and after the swap.

**Leave behind:** `conf/`, `scripts/`, and all bun-specific build tooling/eslint config — `@keetar/core` uses its own pnpm/webpack/vitest setup per §2.4.

---

## 3. Cryptography Engine

> **This is the most critical module. All crypto must be correct and tested before any other work proceeds.** Lives entirely in `@keetar/core`.

Use the Web Crypto API (via the platform-crypto interface, §2.5) for everything it supports natively. Use audited WASM/JS libraries only for algorithms it does not (Argon2, ChaCha20).

### 3.1 Libraries

| Library | Purpose |
|---|---|
| `argon2-browser` | WASM build of the reference Argon2 implementation. Use the WASM variant (not the JS fallback) for timing correctness. Runs natively under Node's `WebAssembly` global for core's tests; loaded via `importScripts()` inside the service worker at runtime for MV3 CSP compliance (§11.4). |
| `@stablelib/chacha` | Pure JS ChaCha20 (package name is `@stablelib/chacha`, not `@stablelib/chacha20`). Used for the KDBX4 inner stream (protected field encryption) and payload cipher. Small, audited, zero native deps. |
| `@xmldom/xmldom` | DOM-compliant XML parser for environments without a native `DOMParser` (service worker, Node tests). Required since KDBX's XML payload layer needs real DOM parsing, not just string handling. |
| `tldts` | TLD-aware domain parsing for autofill matching. ~10KB. Handles `.co.uk`, `.com.au`, etc. Do not implement this yourself. |
| `fflate` | DEFLATE compression/decompression for KDBX payload blocks. Smaller and faster than pako. Also covers zip (`unzipSync`), reused as-is for 1PUX import (§9) — 1Password's export format is a zip archive, not plain JSON. |

### 3.2 KDBX4 Decryption Pipeline

Execute these steps in strict order. Any HMAC failure must abort immediately with a clear error — do not attempt to continue with potentially corrupt or tampered data.

```
1.  Read header magic bytes — must be: 0x03D9A29A 0x67FB4BB5
2.  Parse version field — must be 0x00040000 (KDBX4). Anything else (KDBX3's
    0x00030001, or older) is unsupported: abort with a clear "unsupported
    database version" error, not a generic parse failure or silent fallback.
    Reject explicitly here, on the read path — don't rely on a downstream
    cipher-selection switch to fail implicitly when it hits an unimplemented
    KDBX3 code path (e.g. an unhandled inner-stream cipher). Both read and
    write must reject KDBX3 with the same clear error (§14).
3.  Read TLV header fields:
      - Cipher UUID (AES-256 or ChaCha20)
      - Compression flag
      - Master seed (32 bytes, random)
      - KDF params (Argon2 variant, memory, iterations, parallelism, salt)
      - Encryption IV
      - Inner random stream ID + key
4.  Derive composite key:
      SHA-256(master_password_utf8) || SHA-256(key_file_bytes)  [key file optional]
5.  Run Argon2id KDF:
      Input: composite key
      Params: from header (memory, iterations, parallelism, salt)
      Output: 32-byte transformed key
6.  Derive final keys:
      key_material = SHA-256(master_seed || transformed_key)
      cipher_key   = first 32 bytes of key_material
      hmac_key     = SHA-512(master_seed || transformed_key || 0x01)
7.  Verify header HMAC:
      HMAC-SHA256(hmac_key, all_header_bytes)
      *** If this fails → surface "Incorrect password or key file". Do NOT say "corrupt file". ***
8.  Decrypt payload:
      AES-256-CBC(cipher_key, IV) over the encrypted block data
9.  Verify block HMACs:
      Each 1MB block has an HMAC-SHA256 checksum — verify ALL blocks before proceeding
10. Decompress:
      DEFLATE decompress if compression flag was set in header
11. Parse XML and decrypt protected fields:
      Initialise ChaCha20 inner stream with key from header
      For each entry field with Protected="True": XOR field bytes with stream output
```

> ⚠️ Step 7 distinguishes a wrong password from a corrupt file. The user almost always has the wrong password or key file. Surface that message, not a generic error.

### 3.3 Encryption (Write Path)

Mirror the decryption pipeline in reverse. **Always generate fresh random values** for master seed, encryption IV, and inner stream key on every save — never reuse values from a previous encryption. This is correct behaviour, not a performance issue.

### 3.4 Session Key Lifecycle

The derived cipher key (output of step 6 above) is the session key. It lives **only** in service worker module-level memory (`@keetar/web`) — never written to storage, wrapped or otherwise. What §6.2's `session-key.ts` actually wraps for biometric unlock is `KdbxCredentials.passwordHash`, not this derived key — see §6.2's note and §2.4's `session-key.ts` entry for why.

- **On lock:** Overwrite the key buffer with zeros, then set reference to `null`
- **On Chrome MV3 SW termination:** Key is lost — user must re-enter master password (or re-run the biometric/file-permission unlock gesture, §6.2, §4.2). This is correct and expected.
- **Keepalive:** `chrome.alarms.create("keepalive", { periodInMinutes: 0.4 })` — fires every 24s. Handling any alarm event prevents SW termination.
- **Popup ping:** Popup sends a no-op message to background every 20s while open.
- **Idle timeout:** Configurable (default 5 min). Use `chrome.idle` API. Lock on `"locked"` or `"idle"` state.
- **`SESSION_EXPIRED` message:** Background broadcasts this if SW restarts with no session. Popup and manager show a re-lock screen immediately — treat as a normal lock, not an error.

---

## 4. Local Storage: OPFS Cache & File System Access API

`@keetar/web` uses two distinct browser storage mechanisms for two distinct jobs. Do not conflate them:

| Mechanism | Job | Scope |
|---|---|---|
| **File System Access API** | Read/write a real file on the user's disk (e.g. inside a Dropbox/Drive/OneDrive-synced folder) | Local-file backend — near-term primary path, §4.2 |
| **OPFS** (Origin Private File System) | Encrypted local cache of a vault whose source of truth is a cloud provider's API, plus all auth-related secrets | Cloud-backed vaults (deferred, §7.3) and universal auth state |

OPFS is origin-private and invisible to the OS filesystem — it cannot point at a folder a desktop sync client manages. The File System Access API is the only mechanism that can. They are not interchangeable.

### 4.1 OPFS Storage Layout

Everything stored here is either encrypted or non-sensitive metadata. The extension origin (`chrome-extension://<id>` or `moz-extension://<id>`) is isolated — inaccessible to web pages or other extensions.

```
/vault-<uuid>.kdbx          Encrypted KDBX blob — CACHE of a cloud-backed vault only.
                             Local-file-backed vaults are re-read from the file handle on
                             every unlock instead (§4.2) and are never cached here. Populated
                             by `providers/opfs-cache.ts`'s `OpfsCachedProvider` (§4.3, §7.3),
                             wrapping the Google Drive backend.
/vault-<uuid>.meta.json      { provider, filePath, lastModified, eTag, dirty } — cloud vaults
                             only. `dirty` is one addition beyond this row's original shape:
                             true when the cached blob has local edits not yet confirmed
                             written to the cloud copy (§4.3's offline-save case) — needed to
                             tell step 3b (local newer, safe to retry) apart from step 3c (both
                             sides changed, a real conflict) when the *next* unlock reconciles.
/biometric-<uuid>.json       { credentialId, prfSalt, wrappedPasswordHash, enrolledAt } — all
                             backends. One record, not three (§6.2) — credentialId, prfSalt, and
                             the wrapped hash are always read and written together, so an earlier
                             draft's split into /session-*.bin + /keysalt-*.bin + /biometric-*.json
                             just fragmented one logical record across three files for no benefit.
/keyfile-<uuid>.bin          Key file bytes encrypted with AES-256-GCM + device secret
/oauth-<provider>.json       { ivBase64, ciphertextBase64 } — AES-256-GCM-encrypted
                             { accessToken, refreshToken, expiresAt }, device-secret-protected
                             (§7.3, §10). One record per provider ("gdrive" first), not per
                             vault — a Drive connection isn't scoped to a single vault file.
/device-secret.bin           Random 256-bit device-local secret (storage/device-secret.ts, §7.3,
                             §10) — protects key files (above) and OAuth tokens (above) at rest.
                             Built alongside OAuth token storage in Phase 10, since neither prior
                             phase actually needed it yet (key file support isn't wired up in the
                             extension itself despite this row predating Phase 10 in the doc).
/settings.json               UI preferences, idle timeout, autofill config — no key material
```

**UUID derivation:** an earlier draft of this section specified `SHA-256(provider + ":" + filePath)`, framed as enabling a vault to keep the same identity across a backend switch. That framing doesn't actually hold under its own formula — changing `provider` changes the hash input, so a switch was never going to preserve identity regardless of implementation — and `local-file.ts` (§4.2, Phase 2) already deviated from it for an unrelated, real reason: the File System Access API gives no stable path string to hash, only a sandboxed handle. Google Drive (§7.3, §10) *does* have a stable path (the file ID), but given the hash-based scheme wasn't actually delivering cross-backend continuity even where it could apply, `gdrive.ts` follows local-file.ts's precedent instead: a fresh `crypto.randomUUID()` minted whenever a vault is picked or connected. Switching a configured vault's backend is a new vault configuration, not an in-place migration — biometric enrollment isn't carried over; re-enroll if wanted on the new copy.

### 4.2 File System Access API (Local-File Backend)

#### Mechanism

The user selects a file via a picker dialog (`showOpenFilePicker()`). The extension receives a `FileSystemFileHandle` that supports read and write. The handle is persisted in **IndexedDB**, not OPFS (the handle is a reference, not vault content) and not `chrome.storage.local` as earlier drafts of this doc said — `chrome.storage.local` only accepts JSON-serializable values, and `FileSystemFileHandle` isn't one. IndexedDB supports it via the structured clone algorithm, and is reachable from both extension pages and the service worker (same origin), so either can read back a handle the other stored:

```
IndexedDB "keetar-file-handles" / store "handles": { "<uuid>": FileSystemFileHandle }
```

`showOpenFilePicker()` itself can only be called from a document with active user activation — a service worker has no window and cannot show it. §4.1's `SHA-256(provider + ":" + filePath)` UUID derivation also doesn't apply to this backend specifically: the File System Access API deliberately exposes no stable "path", only the sandboxed handle and its bare (non-unique) filename. This backend instead mints a fresh random UUID at pick time and persists the `{uuid -> handle}` association directly — the namespacing *intent* behind §4.1 still holds, just via a different derivation for this one backend.

Reusing a stored handle requires calling `handle.requestPermission()` — this needs a user gesture but not re-navigating the file picker. In practice this only reintroduces a prompt after permission has actually lapsed (browser restart, §4.2 below); within a session, a handle already granted resolves without one, so the service worker can call this freely once a page has completed the initial grant.

#### Permission Persistence Behavior

File handle permissions lapse on browser restart. This is **intentional and desirable** for a password manager:

- Browser restart → permission lapses → user must re-unlock → re-granting file access is part of the unlock gesture
- Aligns with KeePassXC's own behavior (lock on screen lock, lock after timeout, etc.)

**The unlock flow is a single coherent gesture:** open extension → WebAuthn PRF or master password → `requestPermission()` on stored handle → vault open.

#### Crash Recovery

A browser crash + session restore can leave the extension believing it's unlocked while the file handle is dead. **Required:** validate the file handle is still accessible (try/catch around a lightweight read) before displaying any vault data; on failure, drop to the lock screen.

#### No Background File Watching

The File System Access API gives no file-change notifications, so the extension can't detect edits from KeePassXC desktop or another client. **Mitigation:** re-read the file on every unlock, consistent with how KeePass mobile clients behave.

#### Decision: Local File Is the Near-Term Primary Backend

Not a fallback. It's the lowest-friction path for users who already have a cloud-synced vault on their filesystem via a desktop sync client, and it ships before any direct OAuth work starts (§7.3). From the extension's perspective, whether that folder happens to be synced by Dropbox, Drive, OneDrive, or nothing at all is invisible — it's just a local file.

### 4.3 Sync Strategy (Cloud-Backed Vaults Only)

This applies once direct cloud OAuth ships (§7.3) and OPFS is acting as a cache. Local-file-backed vaults don't need this — see §4.2's re-read-on-unlock mitigation instead.

```
On unlock:
  1. Fetch cloud file metadata (lastModified, eTag)
  2. Compare with stored vault-<uuid>.meta.json
  3a. Cloud newer → re-fetch blob, re-decrypt, update OPFS cache
  3b. Local newer (offline edits) → queue upload on next successful connection
  3c. Both changed → surface conflict UI — do not silently overwrite either copy

On every save:
  1. Write to cloud first
  2. On cloud success → update OPFS cache
  3. On cloud failure → keep dirty flag, retry on next connection
```

> ⚠️ OPFS is always a **cache** of the cloud copy, never the source of truth for cloud-backed vaults. Never treat a successful OPFS write as a successful save.

**Built**, as `providers/opfs-cache.ts`'s `OpfsCachedProvider` — a decorator wrapping *any* cloud `FileProvider` (`gdrive.ts` today; provider-agnostic, so `dropbox.ts`/`onedrive.ts` get it for free whenever they're built), not part of `gdrive.ts` itself. `providers/index.ts`'s `createFileProvider` wraps Google Drive in it automatically; local-file stays unwrapped, since §4.2's own re-read-on-unlock already covers that backend.

- **On unlock (`read()`):** fetches cloud metadata, compares against the cached `vault-<uuid>.meta.json` record. Cloud `eTag` unchanged → serve the OPFS-cached blob directly (this is what makes an already-opened vault usable offline at all). Cloud changed and the cache isn't locally dirty → step 3a, re-fetch and update the cache. Cache dirty *and* cloud changed → step 3c, throws `SyncConflictError` rather than guessing — propagates up through `unlock()`/`unlockWithHash()`, and `message-bus.ts`'s `registerMessageHandler` tags the resulting `{ ok: false }` response with `code: 'SYNC_CONFLICT'` so Popup can point the user at Options instead of just showing a generic error. If the cloud metadata fetch itself fails (genuinely offline, not just "unchanged"), falls back to serving the cache blob if one exists at all, rather than failing the unlock outright.
- **On every save (`write()`):** cloud first. A real conflict — `gdrive.ts`'s own *session-scoped* `CloudConflictError` firing (someone else changed the file during this unlocked session) — propagates immediately, same as it would unwrapped. Any other failure (network down, cloud unreachable) is treated as step 3's offline case: the edit still gets written to the OPFS cache (so it's never lost even if the service worker dies before reconnecting) and the cache record is marked `dirty: true`, but `write()` itself doesn't throw — consistent with §14's auto-save never blocking on network state. The very next successful `write()` naturally retries (Kdbx's `save()` always serializes the *entire* current tree, not a diff, so "retry" is just "the next normal save carries the same edits forward") — no separate queue data structure needed. The next `read()` (next unlock) is what actually reconciles a `dirty` cache against the cloud, via the 3a/3b/3c logic above.
- **Conflict resolution UI (3c):** deliberately simpler than Combine Vaults' per-entry merge (§9 addendum) — a whole-file binary choice, "keep this device's copy" or "keep Google Drive's copy," surfaced in Options' new "Sync status" section (`checkVaultSyncStatus`/`resolveVaultSyncConflict`, `providers/index.ts`) rather than a field-level reconciliation. Two independently-edited encrypted `.kdbx` blobs can't be byte-diffed the way Combine Vaults' entries can; picking one whole file is the honest option here. `resolveConflict('keep-local')` needed one more piece: `GoogleDriveProvider.forceWrite()` (new), which bypasses that provider's own session-scoped revision guard — the whole point of "keep local" is overwriting the cloud's current state, so re-running the same guard that detected this exact conflict would just immediately re-block the fix.

This closes out the scope Phase 10's first pass deliberately deferred (see that phase's row below) — full §4.3 behavior is no longer aspirational.

---

## 5. Autofill System

### 5.1 Architecture: Content Script Is Dumb by Design

The content script runs inside potentially hostile page contexts. It must never hold credentials. Strict division of responsibility:

| Component | Responsibility |
|---|---|
| Content script | Detect login form presence, signal background with tab URL, receive fill message, inject into DOM |
| Background | Domain matching, entry lookup, decide whether to autofill, send credentials |
| Popup | Show match list when multiple entries match |

The content script cannot initiate a vault read. It can only say "there is a login form at `<url>`."

### 5.2 Login Form Detection

Check in this priority order — stop at first match:

1. `autocomplete="username"` / `autocomplete="current-password"` (most reliable)
2. `input[type="email"]` paired with `input[type="password"]`
3. `input[type="text"]` + `input[type="password"]` pair (check proximity in DOM)
4. `name` / `id` attributes matching: `user`, `login`, `email`, `pass`, `pwd`, `credential`
5. `<label>` text containing "username", "email", "password"
6. `placeholder` text containing the same keywords

Use a `MutationObserver` to detect forms added dynamically by SPAs. Disconnect the observer once a form is found on a given page load.

> ⚠️ **Multi-step login flows** (Google, Microsoft, Apple): detect when a password field is absent but a username field is present. In this case, only pre-fill the username and wait — do not attempt to fill a non-existent password field.

### 5.3 Credential Injection

Standard DOM value assignment does not trigger React/Vue/Angular change detection. Use the native setter pattern:

```js
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value'
).set;

nativeInputValueSetter.call(field, value);
field.dispatchEvent(new Event('input',  { bubbles: true }));
field.dispatchEvent(new Event('change', { bubbles: true }));
```

### 5.4 URL Matching Algorithm

Run against the active tab URL on every autofill lookup. Return entries at the **highest tier** that has matches.

| Tier | Condition |
|---|---|
| 1 — Exact URL | `normalise(entry.url) === normalise(tab.url)` (lowercase, strip trailing slash) |
| 2 — Exact hostname | `new URL(entry.url).hostname === new URL(tab.url).hostname` |
| 3 — Base domain | `tldts(entry.url).domain === tldts(tab.url).domain` |
| 4 — Title fallback | `entry.title.toLowerCase().includes(tab.hostname)` |

Also check `KP2A_URL_1`, `KP2A_URL_2`, etc. custom string attributes at all tiers — KeePassXC stores extra domains here.

**On match result:**
- 0 matches → badge shows `0`, no automatic action
- 1 match → autofill directly if "auto-fill on page load" is enabled, otherwise show badge `1`
- N matches → open popup showing match list, let user choose

### 5.5 TOTP Autofill

After filling username + password, check if the matched entry has a TOTP secret. If yes, and the page has a visible OTP input field (look for `autocomplete="one-time-code"` or a 6-digit `maxlength` input), offer to fill the TOTP code as well.

---

## 6. Authentication & Biometric Unlock

### 6.1 Unlock Modes

Present to user in this order (skip modes that are unavailable):

1. **Biometric** — if enrolled and PRF is supported by platform (fastest, show first)
2. **Master password only**
3. **Master password + key file**
4. **YubiKey FIDO2** — same WebAuthn code path as biometric, roaming authenticator
5. **YubiKey HMAC-SHA1** — Chrome only via WebHID. Show clear note in Firefox that this mode requires Chrome.

### 6.2 WebAuthn PRF Biometric Flow

The PRF (Pseudo-Random Function) extension causes the authenticator to produce a deterministic 32-byte output each time the user authenticates. This output is used as the vault unlock key (VUK) to unwrap the stored session key.

**Enrollment (Options, §8.2 — needs a live master password, which is why this lives in Options' scoped one-time unlock, not Popup/Manager's shared session):**

```
1. User enters the master password. Verify it's actually correct before enrolling
   anything — read the vault file (LocalFileProvider, same as any unlock) and
   attempt Kdbx.load(). If it fails, stop here with "incorrect password": don't
   let a typo silently brick biometric unlock until the user tries it later.
2. Generate 32-byte random prfSalt.
3. Call navigator.credentials.create() with prf extension:
     extensions: { prf: {} }
     user.id = SHA-256(vaultUUID)
4. VUK = assertion.getClientExtensionResults().prf.results.first  (32 bytes)
5. AES-KW wrap credentials.passwordHash (32 bytes — SHA-256 of the master
   password, not the derived session key; see this section's note above) using VUK
6. Store { credentialId, prfSalt, wrappedPasswordHash, enrolledAt } as a single
   OPFS record (§4.1) — one file per vault, not the three separate files
   (/keysalt-*, /session-*, /biometric-*) an earlier draft of this doc split
   this into; they're one logical record, always read and written together.
7. Discard VUK and the verification Kdbx instance from memory immediately.
```

**Unlock (Popup, §8.1 — the surface that actually prompts for the master password; shown as an alternative to it when a biometric credential exists for the configured vault):**

```
1. Read { credentialId, prfSalt, wrappedPasswordHash } from the OPFS record.
2. Call navigator.credentials.get():
     allowCredentials: [{ id: credentialId, type: 'public-key' }]
     extensions: { prf: { eval: { first: prfSalt } } }
3. OS performs biometric check (Face ID / Touch ID / Windows Hello / YubiKey)
4. VUK = assertion.getClientExtensionResults().prf.results.first
5. AES-KW unwrap wrappedPasswordHash using VUK → the 32-byte password hash
6. Send it to background: construct `new KdbxCredentials(null)`, await
   `.ready`, then set `.passwordHash` directly (a public field) to that hash
   before calling `Kdbx.load()` — same unmodified core load path as a normal
   password unlock from that point on, just skipping the "hash the password
   string" step, not the Argon2 KDF itself.
7. Discard VUK immediately. Vault is unlocked.
```

If the active backend is the local-file provider (§4.2), fold `handle.requestPermission()` into the same gesture: biometric/password unlock and file-access re-grant happen as one user interaction, not two. In practice this holds as long as file permission hasn't actually lapsed (browser restart) — within a session, `LocalFileProvider`'s own permission check (§4.2, §7.2) resolves without a fresh prompt, so the background service worker (which is what actually calls `provider.read()` once Popup hands it the unwrapped hash) doesn't need transient activation of its own. If permission *has* lapsed, that read fails and the user falls back to the password field in the same Popup — which, being a page, always has a fresh gesture available.

> ⚠️ **`file://` origins break PRF in Chrome, Edge, and Safari.** WebAuthn requires an effective domain, which `file://` origins don't have — this is a W3C spec-level restriction ([w3c/webauthn#474](https://github.com/w3c/webauthn/issues/474)), not a bug either browser can fix with a flag. Firefox is the one exception; it allows WebAuthn (and therefore PRF) on `file://`. This extension runs from a `chrome-extension://`/`moz-extension://` origin, not `file://`, so it isn't directly exposed to this — but it matters the moment any companion surface (a locally-opened HTML page, an `<iframe>` pointed at a `file://` doc, etc.) is considered. Master-password unlock has no such restriction and must always work as the universal fallback regardless of origin.

### 6.3 Browser Compatibility for PRF

| Browser | Support |
|---|---|
| Chrome 116+ | Full PRF — platform authenticators (Touch ID, Windows Hello) + FIDO2 hardware keys |
| Firefox 119+ | Full PRF — platform authenticators + FIDO2 hardware keys |
| Safari 16+ | Passkeys (resident keys) only. PRF extension not supported. Fall back to password-only unlock. |
| Older | Detect via `try/catch` on `getClientExtensionResults().prf`. Fall back gracefully. |

### 6.4 WebHID YubiKey (HMAC-SHA1 Challenge-Response)

This is the legacy YubiKey mode used by KeePassXC desktop (distinct from FIDO2).

- Chrome only — Firefox does not implement the WebHID API
- Requires explicit `hid` permission in manifest and a user permission prompt each session
- If permission denied or browser is Firefox: surface a clear message and fall back to FIDO2 mode
- Implementation: `navigator.hid.requestDevice({ filters: [{ vendorId: 0x1050 }] })` — YubiKey vendor ID

### 6.5 Key File Support

| Key file type | Handling |
|---|---|
| KeePass XML v2 (recommended) | Parse XML, extract `<Key><Data>` element, base64-decode |
| KeePass XML v1 | Parse XML, extract hex key material |
| 32-byte binary | Use bytes directly as key material |
| Arbitrary file | `SHA-256(file_bytes)` used as key material |

Store key file encrypted in OPFS as `/keyfile-<uuid>.bin`. User uploads once during setup; extension handles it silently thereafter.

---

## 7. Storage Backends

### 7.1 FileProvider Interface

All providers implement this interface, defined as a type in `@keetar/core` (§2.5). Background script talks only to this interface — no provider-specific code outside `@keetar/web`'s `providers/` directory.

```ts
interface FileProvider {
  read(path: string): Promise<ArrayBuffer>
  write(path: string, data: ArrayBuffer): Promise<FileMetadata>
  metadata(path: string): Promise<FileMetadata>    // lastModified, eTag, size
  list(dir: string): Promise<FileListing[]>         // for file picker UI
  revoke(): Promise<void>                            // clear tokens, deauthorise
}

interface FileMetadata {
  lastModified: string   // ISO 8601
  eTag: string
  size: number
}
```

### 7.2 Local File (`local-file.ts`) — Ships First

Implements `FileProvider` over the File System Access API (§4.2). No OAuth, no network calls, no OPFS caching — reads and writes go straight to the user's `FileSystemFileHandle`. `metadata()` derives `lastModified` from the underlying `File` object; there's no `eTag` concept, so conflict detection for this backend is just "re-read before every unlock" (§4.2), not the cloud sync algorithm in §4.3.

This is the backend built in Phase 2 (§12) and is what the extension ships with at first release.

### 7.3 Direct Cloud OAuth

Direct OAuth is a primary long-term goal (§1.1), sequenced after the local-file backend shipped and stabilized (§7.2, Phases 2–9). **Google Drive built in Phase 10 (§12)** — Dropbox and OneDrive remain deferred behind it, per the build order below, not yet started.

| Provider | Difficulty | Status / Blocker |
|---|---|---|
| Google Drive | Medium | **Built (Phase 10/11).** Uses `identity.launchWebAuthFlow`, but — unlike Dropbox/OneDrive below — *not* `oauth-pkce.ts`'s authorization-code+PKCE flow. Google's own OAuth backend ruled that out for reasons with nothing to do with Firefox vs. Chrome; see [Why Google Drive Doesn't Use PKCE](#why-google-drive-doesnt-use-pkce) for the full story. |
| Dropbox | Medium | Not started. Clean PKCE REST API; friction is extension redirect URIs — `oauth-pkce.ts` (still the default, shared mechanism for new providers) should cover it with a new `PkceProviderConfig` and its own `providers/dropbox.ts`, no new OAuth mechanism needed. |
| OneDrive | Hard | Not started. MSAL.js has poor extension support; hand-rolled PKCE; personal vs. work/school use different authority URLs. |

**Constraints, and how Google Drive's build actually satisfied each one:**

- **Redirect URIs aren't stable for extensions.** Handled by `identity.getRedirectURL()` (§9.2's platform shim) rather than a hardcoded URI — it always reflects whatever ID the currently-running extension actually has, dev or published, so nothing needs registering per-build; only the *Google Cloud Console* side needs a real redirect URI on file (see the setup walkthrough below), and that has to be updated if the extension's ID changes (e.g. moving from a pinned dev ID to the real Chrome Web Store ID at publish time).
- **Refresh tokens can't live in memory.** `providers/oauth-token-store.ts` persists `{ accessToken, refreshToken, expiresAt }` in OPFS, AES-256-GCM-encrypted via `storage/device-secret.ts` (new — see §4.1's OPFS layout).
- **CORS.** `GoogleDriveProvider` (`gdrive.ts`) only ever runs from `vault-session.ts` (background) for actual vault read/write, matching every other provider. The OAuth *connect* flow and Drive Picker are the one exception, running from Options instead (see below) — consistent with Options already owning "backend/provider setup" directly (it already calls `local-file.ts`'s `pickVaultFile()` the same way, not through background).
- **MV3 service worker keepalive.** Not a practical concern for what got built: a single vault file's read/write is one request/response cycle, not a long-running sync operation — nothing here approaches the ~30s mark. This becomes relevant if/when §4.3's full OPFS-cache/offline-queue sync is eventually built (not done yet — see §4.3's own note).
- **Conflict resolution.** Scoped down for this first pass — see §4.3's note on what shipped (a session-scoped `headRevisionId` guard that refuses to overwrite, via `CloudConflictError`) versus what's deferred (the full reconcile-or-queue algorithm).

#### OAuth2 Strategy

`providers/oauth-pkce.ts` — one provider-agnostic PKCE (Authorization Code + Proof Key for Code Exchange) implementation, used via `identity.launchWebAuthFlow` (§9.2's platform shim wraps both `chrome.identity.launchWebAuthFlow` and `browser.identity.launchWebAuthFlow`). This is still the intended shared mechanism for **Dropbox and OneDrive** once those start. **Google Drive doesn't use it** — a real, discovered limitation of Google's own OAuth backend ruled it out; see [Why Google Drive Doesn't Use PKCE](#why-google-drive-doesnt-use-pkce) below for the full story. Google Drive instead uses the OAuth2 *implicit* grant, also via `identity.launchWebAuthFlow`, hand-rolled directly in `providers/gdrive.ts` rather than through `oauth-pkce.ts`.

**For Google Drive specifically:**

- **Access tokens:** Short-lived (~1 hour), kept in `GoogleDriveProvider`'s in-memory instance field for the session.
- **No refresh tokens.** The implicit grant never issues one, by design — see below. `providers/oauth-token-store.ts` (AES-256-GCM encrypted in OPFS via `storage/device-secret.ts`) stores `{ accessToken, expiresAt }` only.
- **"Refresh" is really silent re-authorization.** When the stored access token is expired (or a 401 forces the issue), `getAccessToken()` re-runs the same implicit-grant flow with `interactive: false` — invisible to the user as long as they're still signed into Google in that browser profile; surfaces as an ordinary "Google Drive is not connected" failure otherwise, which Options' existing reconnect UI already handles.
- **Auto-refresh trigger:** `GoogleDriveProvider.authorizedFetch` intercepts 401 responses, force-refreshes once, retries the original request. A time-based expiry check (`getAccessToken`, 60s margin) avoids hitting 401 for the common case.
- **Revocation:** `disconnectGoogleDrive()` deletes the OPFS token file and best-effort calls Google's `/revoke` endpoint (failure there doesn't block the local disconnect the user asked for).

**For Dropbox/OneDrive (once built), the original design still applies:** PKCE means no client secret ever exists to protect — a browser extension is a public client that can't keep one confidential, so `code_verifier`/`code_challenge` prove possession of the original authorization request instead of a shared secret proving client identity. The Client ID itself isn't sensitive (it identifies the app, doesn't authenticate it), so it's baked into the built extension rather than needing runtime configuration.

#### Why Google Drive Doesn't Use PKCE

This started as a straightforward application of the shared design above, and turned into a real investigation once live testing (2026-08-06) hit a wall the docs didn't predict.

**The original plan — PKCE, no secret, same as everything else:**

`oauth-pkce.ts`'s authorization-code+PKCE flow, same OAuth Client ID for both browsers, secret never sent. This is exactly what §7.3's design has always called for, and initially seemed to work.

**What broke it:** Connecting from a real build produced a 400 from Google's token endpoint:

```json
{ "error": "invalid_request", "error_description": "client_secret is missing." }
```

Confirmed directly, not assumed:
- Removing `access_type=offline` (dropping the refresh-token request entirely) made **no difference** — same error. This isn't about requesting long-term access; it's unconditional for this client type.
- Google's own docs (both the native-app and web-server pages) list `client_secret` as *optional* in the token-request schema — technically true, but misleading here. The real mechanism, confirmed by reading a [Stack Overflow thread](https://stackoverflow.com/questions/63057801) on the underlying OAuth spec: whether a client needs a secret is decided by how it's *registered* (its client type), not by whether a given request happens to include PKCE parameters. Google's **"Web application"** client type is registered as confidential, full stop — PKCE doesn't change that classification.

**Options considered and ruled out:**

| Option | Why it didn't work |
|---|---|
| Embed the secret anyway (like `rclone` does with its own shared Google client) | Technically viable — a Google API key/secret isn't a real confidentiality boundary for a distributed public client either way — but abandoned once a secret-free path was found working live; no reason to accept the (narrow but real) client-identity-abuse risk once it wasn't necessary. |
| Switch to `chrome.identity.getAuthToken()` (Chrome's own native, genuinely secret-free mechanism, via a dedicated "Chrome Extension" client type) | Confirmed broken for **newly-created** clients: Google's server rejects the redirect scheme this mechanism constructs internally (`redirect_uri_mismatch`), with no field exposed anywhere to fix it. Matches a still-open upstream Chrome/Google issue, not a mistake on this project's end. Chrome-only besides — Firefox has no equivalent API at all. |
| Switch to Google's "Desktop app" client type (their actual public-client category, genuinely secret-free) | Its console UI doesn't expose an editable redirect URI field at all — it's implicitly loopback/custom-URI-scheme only, which `launchWebAuthFlow`'s browser-vendor redirect domains (`chromiumapp.org` / `extensions.allizom.org`) can't satisfy. Confirmed live, not assumed from docs. |
| Google's device-authorization flow (built for TVs/limited-input devices, also a public-client category) | Google's own docs list `client_secret` as required for the token-polling step too — same wall, different flow. |

**What actually shipped — the OAuth2 *implicit* grant (`response_type=token`):**

No token-endpoint call at all — the access token comes back directly in the redirect URL's fragment. Since the client-secret requirement above is specifically about the *authorization_code* grant, the implicit grant sidesteps it entirely. Verified live: Google issues a full `drive.file`-scoped token this way with zero secret involvement, on the exact same "Web application" Client ID the PKCE attempt used (it already had both browsers' redirect URIs registered).

**The real cost, and why it's an acceptable trade:** No refresh token, ever, by flow design — not a bug, not something a future fix unlocks. In exchange, `getAccessToken()` transparently redoes the implicit flow with `interactive: false` whenever the current token's expired (see the OAuth2 Strategy bullets above) — invisible to the user in the common case, and no worse than "reconnect in Options" in the uncommon one.

#### The Road to a Working Picker on Firefox

**Google Drive** | Chrome works cleanly with the design above. **Getting the same result on Firefox took a second, separate investigation** — this one about the Picker widget specifically, not the OAuth token that feeds it.

**The blocker:** opening the Picker directly from the extension page (exactly like Chrome does) produced a genuine, server-rendered 403 from Google — not a client-side error. Isolated directly: the *only* variable that changes between a working Chrome request and a failing Firefox one is the origin scheme itself, `chrome-extension://` vs `moz-extension://`. Confirmed with a deliberately crude test — manually swapping just the `origin=` parameter to a `chrome-extension://`-shaped string made the *exact same* Firefox request succeed. Google's Picker backend evidently recognizes `chrome-extension://` as a tolerated (if undocumented) origin scheme and has simply never been built to recognize `moz-extension://` at all.

**Ruled out on the spot:** fabricating a fake `chrome-extension://`-shaped origin to get past this check. Even setting aside that it means lying to a third party's access control, it very likely wouldn't have worked end-to-end anyway — Picker's result channel would target whatever origin it was told, never reaching this extension's real one.

**The fix that actually works needs Picker running from a real `https://` origin** — the case it's actually built for. `google-picker-bridge` (github.com/papacodebear/google-picker-bridge) is a small static page, hosted separately (currently on Cloudflare), that does exactly that. Getting there took three real attempts, not one:

1. **Embed the bridge as an `<iframe>`** inside the Options page. Broken by a *different* mechanism than the 403 above: Picker's own client-side check compares the origin it's given against `window.location.ancestorOrigins` — a real, browser-computed, unspoofable property of the actual frame-nesting chain. Nested under the extension's own page, that always reports the extension's real origin, no matter what the bridge claims (`PickerBuilder.setOrigin()`/`setRelayUrl()` included — traced into Picker's own minified source to confirm this precisely, not guessed at). No single value can satisfy both this check and the need to present a real `https://` origin at the same time, while nested.
2. **Open the bridge as a popup instead of an iframe.** A popup has no ancestors at all, so the `ancestorOrigins` check above is skipped entirely (it's explicitly guarded on `ancestorOrigins.length > 0`) — this part worked. But the `postMessage`-based handshake built around it didn't, in *both* directions, confirmed live: `window.opener` is simply absent on Firefox for a popup opened from a privileged extension page (evidently a deliberate boundary against letting less-trusted opened content reach back into extension-privileged code), and resending a message on a retry interval to work around that requires re-calling `window.open()`, which gets silently popup-blocked on every attempt after the first (not tied to a fresh user gesture).
3. **Pass data through URLs instead of `postMessage`, in both directions.** What actually shipped. The extension puts `accessToken`/`developerKey`/a callback URL directly in the popup's URL hash fragment at `window.open()` time (never sent to any server — hash fragments are client-side only); the bridge reads that on load, no message needed. On completion, the bridge navigates itself to a small page bundled *in* the extension (`picker-callback.html`, declared in `manifest.firefox.json`'s `web_accessible_resources` so an external page can navigate to it at all) with the result in its own hash fragment. That page runs with full extension privileges, so it relays the result via `chrome.runtime.sendMessage` — real extension messaging, sidestepping cross-origin messaging (and its live-reference problems) entirely for that direction too.

**Real bugs found along the way, not just design dead ends:**

- `gapi.load('picker', ...)` dynamically injects further script tags whose content is a JSONP-style call, `gapi.loaded_N(...)`, where `N` is a live counter — not the fixed `0` the original vendoring assumed. Fixed in `google-picker-offline-loader` by discovering each vendored file's own baked-in callback name at runtime and aliasing it to whatever name was actually requested, rather than assuming.
- The first fix attempt for that rewrote the vendored file's bytes and served the patched result via a `blob:` URL — blocked by the extension's own `script-src 'self'` CSP. Fixed by leaving the file's bytes untouched entirely and doing the aliasing as a plain global-scope assignment instead.
- Actually rendering the dialog (`setVisible(true)`, not just constructing the builder) turned out to need a *third* dynamically-loaded module (`gapi_iframes`) beyond the two `google-picker-offline-loader` originally captured — only discoverable by exercising that call for real, which the package's own capture/validation harness hadn't done until this investigation prompted it to.
- `picker-callback.html`'s first version used an inline `<script>` block — caught by `web-ext lint`'s `INLINE_SCRIPT` warning, since Firefox's default extension-page CSP has no `'unsafe-inline'`; it would have silently never executed at all. Fixed by moving it to an external `.js` file, matching every other page in this extension.

#### Provider-Specific Notes

| Provider | Notes |
|---|---|
| **Google Drive** | Drive REST API v3. `drive.file` scope (not `drive.readonly` — need write access; not the broader `drive` scope — see the Picker note below for why). Conflict detection via the `headRevisionId` field on `files.get`, not an `If-Match` HTTP header — Drive API v3 doesn't expose file resources with a conventional HTTP ETag the way an S3-style REST API does (an earlier draft of this row assumed it did); `headRevisionId` serves the same comparison purpose. **File picker: the real Google Picker widget**, loaded two different ways depending on browser — see [The Road to a Working Picker on Firefox](#the-road-to-a-working-picker-on-firefox) for why. Chrome loads it directly via `google-picker-offline-loader` (§11.4, §13, an extracted npm package); Firefox routes through `google-picker-bridge`, a separately-hosted page. `providers/gdrive-picker.ts` picks between the two at runtime. The Picker isn't just a nicer file-open dialog, either — it's *load-bearing* for `drive.file` scope specifically: that scope only grants access to files the app created, or files the user hands it through Google's own Picker widget (even ones the app didn't create) — there is no other API path under `drive.file` to reach an arbitrary pre-existing Drive file. |
| **Dropbox** | API v2. Use `/files/upload` with `mode: "overwrite"`. Conflict detection via `rev` field. Dropbox-API-Arg header pattern for metadata. Not started — see the provider table above. |
| **OneDrive** | MS Graph API `/me/drive/items/{id}/content`. Standard OAuth2 flow (MSAL optional). ETag from response headers for conflict detection. Not started — see the provider table above. |

#### Google Cloud Console Setup (Google Drive)

Two separate credentials, both from the same Google Cloud project — neither is a secret to protect carefully (the Client ID identifies the app rather than authenticating it, per PKCE above; the Picker API key is sent to Google directly from a page the user is already looking at), but both need to exist before Google Drive actually works end to end. `GOOGLE_CLIENT_ID` (`providers/gdrive.ts`) and `GOOGLE_PICKER_API_KEY` (same file) start as empty-string placeholders in the code until this is done — **done now**, both filled in by hand per the walkthrough below.

1. **Create or choose a Google Cloud project** at [console.cloud.google.com](https://console.cloud.google.com).
2. **Enable two APIs**, under "APIs & Services" → "Library": **Google Drive API** and **Google Picker API**.
3. **Configure the OAuth consent screen** ("APIs & Services" → "OAuth consent screen"). User type "External" unless this is only ever used inside a Google Workspace org. Add the `drive.file` scope explicitly (not `drive` or `drive.readonly`) under "Scopes." While the app is in "Testing" publishing status, only email addresses added to the consent screen's test-user list can complete the OAuth flow at all — add whichever Google account(s) will actually be used to test this. Moving to "In production" for a scope like `drive.file` (Google classifies it as non-sensitive) shouldn't require the full verification review sensitive/restricted scopes need, but confirm current status in the console before relying on that.
4. **Get each browser's actual redirect URI.** Chrome: `chrome://extensions` → Developer mode → "Load unpacked" → `packages/web/dist/chrome` — the extension ID shown there gives `https://<extension-id>.chromiumapp.org/`. Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → `packages/web/dist/firefox/manifest.json`, then "Inspect" on the loaded extension to open its console and run `browser.identity.getRedirectURL()` directly — gives `https://<hash>.extensions.allizom.org/`. Both IDs are stable across reloads of the same build from the same path (Firefox's specifically because `manifest.firefox.json` pins `browser_specific_settings.gecko.id` — §11), but change if reloaded from a different path, and Chrome's changes again at Web Store publish time (needing step 4 repeated then).
5. **Create one OAuth Client ID for both browsers** ("APIs & Services" → "Credentials" → "Create Credentials" → "OAuth client ID"). Application type **Web application** (not "Chrome Extension" — that type is for `chrome.identity.getAuthToken()`'s implicit flow, which §7.3 above explains this project isn't using). Add **both** redirect URIs from step 4 under "Authorized redirect URIs" — the console accepts multiple per client, so one Client ID/secret pair covers both browsers; nothing about `oauth-pkce.ts` or `gdrive.ts` needs to know which browser it's running on. This step generates a client secret alongside the Client ID — expected, unavoidable in Google Cloud Console's UI even for a type meant to be used as a public client — just don't copy it anywhere; `oauth-pkce.ts` never sends one (confirmed against Google's own docs, both the native-app and web-server pages list `client_secret` as *optional* in the token-exchange request — an earlier, unverified web search result claiming Google requires it regardless of PKCE, and thus a backend server, was checked against the primary source and doesn't hold up).

   **Firefox's default redirect domain (`*.extensions.allizom.org`) was expected to be a real blocker** — Mozilla's own docs describe it as a "dummy domain" some OAuth providers (naming Google specifically) can't accept without verified ownership, and recommend a Firefox 86+ loopback-address fallback (`http://127.0.0.1/mozoauth2/<subdomain>`, RFC 8252 §7.3) for exactly this case. That guidance turned out to be stale: tested directly against a real Google Cloud Console (not assumed from the docs), the plain `*.extensions.allizom.org` redirect URI saved without any verification error. No loopback substitution needed in `platform/firefox.ts` — `identity.getRedirectURL()` stays a direct passthrough to `browser.identity.getRedirectURL()`, unchanged from what Chrome's shim does.

   **"Authorized JavaScript origins" (a separate field in the same console UI) is not needed for any of this.** That field gates direct-JS calls to Google's *authorization* endpoint (the implicit-flow/GSI-button pattern) — `launchWebAuthFlow` doesn't do that; it opens a full browser-tab navigation instead, which that field doesn't govern at all. The other place origin-based rejection could plausibly happen — the token endpoint, since `oauth-pkce.ts`'s `requestTokens()` really does a direct `fetch()` POST to it, a genuinely CORS-subject request — was checked directly (`curl -X OPTIONS` against `oauth2.googleapis.com/token` with a fake `moz-extension://` origin): the endpoint echoes back whatever `Origin` header it's sent with no allowlist check, so no console configuration affects this path either.
6. **Create the Picker API key** ("Credentials" → "Create Credentials" → "API key"). Restrict it ("Edit API key" → "API restrictions") to just the Google Picker API, narrower than the default of "don't restrict key."
7. **Fill in both values** in `packages/web/src/providers/gdrive.ts`: `GOOGLE_CLIENT_ID` (step 5) and `GOOGLE_PICKER_API_KEY` (step 6).

### 7.4 Skipped For Now: iCloud / WebDAV

**Explicit decision: skip, not just deferred behind cloud OAuth.** No committed phase.

- **No CloudKit, no Sign-in-with-Apple integration.** Neither gives programmatic access to `.kdbx` files, and no existing KeePass client (KeePassXC, Strongbox, KeePassium) speaks CloudKit — building on it would fork the KDBX ecosystem into a walled garden.
- **WebDAV** (which would also cover Nextcloud, Synology, etc.) has no OAuth and largely undocumented per-provider quirks (iCloud specifically requires an app-specific password, not the Apple ID password, and a different auth UX from every other provider). Not worth building against until there's concrete demand.
- iCloud remains reachable today the same way as any other provider: as a local file synced by the Files app / iCloud Drive desktop client, via the local-file backend (§4.2, §7.2). No special-casing needed for that path.

If this gets revisited, treat it as a standalone evaluation, not an extension of §7.3's OAuth work.

---

## 8. Extension UI Architecture

### 8.1 Three Surfaces, Split by Unlock State

The extension has three UI surfaces. The popup/manager split is about editing scope (quick access vs. full management); the split with options is about whether a decrypted vault is required at all:

**Popup** (`popup.html`) — quick access, post-unlock. Autofill, credential search, copy username/password, TOTP. Constrained size. The primary daily-use surface.

**Manager** (`manager.html`) — full vault-content management, post-unlock only. Entry editing, group management, attachments, TOTP secret setup, import/export, conflict resolution. Full-page `extension://` URL, no size constraints, can load heavier UI. Owns **no settings** — everything here operates on decrypted entry data.

**Options** (`options.html`) — setup and configuration, reachable **without** unlocking the vault: choosing the local-file backend vs. a cloud provider (once §7.3 ships), idle-timeout and autofill preferences, general UI settings. Two actions here — enrolling a biometric credential and uploading/changing a key file — need a live session key to wrap/unwrap (§3.4, §6.2), so they trigger a one-time, self-contained unlock prompt scoped to just that operation. This is distinct from the full "vault open" state Popup and Manager share, and it never displays decrypted entry content.

Manager is opened via `chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') })` from the popup or options page.

Popup and Manager share the same background service worker and the same unlocked vault session — the vault is unlocked once in the service worker, and both read from it via `chrome.runtime.sendMessage`. Options does not share that session; its two security actions run against their own scoped, ephemeral unlock as described above, not the shared one.

### 8.2 Division of Responsibility

| Surface | Owns | Does not own |
|---|---|---|
| Popup | Credential search/selection, autofill trigger, copy-to-clipboard, TOTP display, quick password generation | Entry editing, group management, settings, import/export |
| Manager | Entry create/edit/delete, group tree management, attachments, TOTP secret setup, import/export, conflict resolution UI | Any settings, provider/security configuration |
| Options | Backend/provider setup, idle-timeout + autofill preferences, biometric enrollment, key file management | Vault content of any kind (entries, groups, attachments) |

Write-path operations (§3.3, kdbx `writer.ts`) are callable from Popup or Manager via the same background message bus — Manager is simply where the editing UI that triggers them lives. Options never calls the write path.

---

## 9. Chrome MV3 / Firefox Compatibility

### 9.1 Key Differences

| Concern | Chrome MV3 | Firefox MV2 |
|---|---|---|
| Background context | Service worker — can be killed at any time | Persistent background page |
| Session durability | Volatile — keepalive + graceful re-lock UI required | Stable for browser session lifetime |
| OAuth | `chrome.identity.launchWebAuthFlow` | `browser.identity.launchWebAuthFlow` |
| Namespace | `chrome.*` | `browser.*` (also accepts `chrome.*` for most APIs) |
| Manifest version | `manifest_version: 3` | `manifest_version: 2` |
| WASM | Allowed in service workers (Chrome 95+) | Allowed in background pages |
| WebHID | Supported | Not supported |

### 9.2 Platform Shim Pattern

```js
// packages/web/src/platform/index.ts
const platform = typeof chrome !== 'undefined' && chrome.identity
  ? await import('./chrome.js')
  : await import('./firefox.js');

export const { identity, storage, alarms, runtime } = platform;
```

Both shims expose the same API surface. `alarms` is a no-op stub on Firefox MV2 (persistent background page makes keepalive unnecessary).

### 9.3 Chrome MV3 Keepalive

```js
// background/keepalive.ts
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // every 24s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // No-op. Handling the event prevents SW termination.
  }
});
```

Additionally, the popup sends a ping message to background every 20s while open. On receiving `SESSION_EXPIRED` from background, popup immediately shows the unlock screen — this is a normal event, not an error state.

### 9.4 Manifest Differences

Both manifests grow incrementally as each phase needs them, not all at once — the actual current shape of each (Phase 10 for Chrome's `identity`/`sandbox`/CSP additions, Phase 11 for the Firefox file existing at all):

```jsonc
// manifests/manifest.chrome.json (MV3) — actual, not aspirational
{
  "manifest_version": 3,
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup/popup.html" },
  "options_page": "options/options.html",
  "content_scripts": [{ "matches": ["http://*/*", "https://*/*"], "js": ["content.js"], "run_at": "document_idle" }],
  "host_permissions": ["http://*/*", "https://*/*"],
  "permissions": ["storage", "idle", "alarms", "clipboardWrite", "tabs", "identity"]
  // No "sandbox"/"content_security_policy" — Google Picker's JS is vendored
  // (via google-picker-offline-loader, §7.3, §11.4, §13), not loaded from
  // Google's remote CDN, so it's same-origin and the default CSP permits it.
}

// manifests/manifest.firefox.json (MV2) — actual, not aspirational
{
  "manifest_version": 2,
  "browser_specific_settings": {
    "gecko": { "id": "keetar@dev.local", "strict_min_version": "142.0", "data_collection_permissions": { "required": ["none"] } }
  },
  "background": { "scripts": ["background.js"], "persistent": true },
  "browser_action": { "default_popup": "popup/popup.html" }, // not "action" — MV2's name (§9.1)
  "options_page": "options/options.html",
  "content_scripts": [{ "matches": ["http://*/*", "https://*/*"], "js": ["content.js"], "run_at": "document_idle" }],
  // MV2 has no separate host_permissions array — host match patterns and
  // API permissions share one flat "permissions" list.
  "permissions": ["storage", "idle", "alarms", "clipboardWrite", "tabs", "identity", "http://*/*", "https://*/*"]
  // No "sandbox"/"content_security_policy" here either, same reason as
  // Chrome's — never needed one to begin with, given vendoring.
}
```

Phase 4 (autofill) added the `content_scripts` slice both manifests now share, plus Chrome's `host_permissions` for the same patterns and the `"tabs"` permission — `host_permissions` specifically because `chrome.tabs.query()`'s results only include a tab's `url` for origins the extension has host permission for (MV3 privacy behavior); without it, Popup's active-tab domain matching would silently get back tabs with no `url` field at all. Note `"scripting"` was never actually added: that permission is for *programmatic* injection (`chrome.scripting.executeScript`), a different mechanism from the declarative `content_scripts` array actually used here — don't add it thinking it's required for content scripts in general. `browser_specific_settings.gecko.id` pins a stable add-on ID for Firefox — needed the same way Chrome's unpacked-load ID needs to stay put for the OAuth redirect URI (§7.3) to keep matching what's registered in Google Cloud Console; unlike Chrome's, this one is set explicitly in the manifest rather than assigned at load time.

---

## 10. Build System & Testing

### 10.1 Webpack Config

`packages/web/build/webpack.config.js` defines five separate bundles — never combine them. In practice this is five separate webpack *config objects* (the file's default export is an array), not five entries in one config — see §13's `webpack` + `ts-loader` row for why (service worker vs. page bundles need incompatible `target`s, and webpack's `target` is config-wide, not per-entry). Phase 10 briefly added a sixth, `sandbox-picker`, for the Google Drive Picker bridge — manifest `sandbox.pages` treated it as a distinct, isolated page with its own CSP, so it couldn't share a bundle with anything expecting `chrome.*` API access. Once the Picker's JS was vendored locally instead of loaded live (§7.3, §11.4), that whole sandboxed-page architecture became unnecessary rather than just reconfigurable, and was removed outright — back down to five.

| Bundle (compiled output) | Entry (TypeScript source) | Runs in |
|---|---|---|
| `background.js` | `src/background/index.ts` | Service worker / background page |
| `content.js` | `src/autofill/content.ts` | Page context (injected) |
| `popup/index.js` | `src/ui/popup/index.tsx` | Extension popup, post-unlock. Entry mounts `App.tsx`'s locked/unlocked state machine — not `App.tsx` directly, so the mount call and the component stay separate. |
| `manager/index.js` | `src/ui/manager/index.tsx` | Extension tab (full page), post-unlock only. Opened via `chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') })` from Popup's "Manage" button, exactly as §8.1 specifies. |
| `options/index.js` | `src/ui/options/index.tsx` | Full options page, reachable pre-unlock. Replaced `src/dev-harness/`'s file-selection bundle once built for real (Phase 7). |

`@keetar/core` is a normal workspace dependency of `@keetar/web`, not a separate bundle. Build targets: `packages/web/dist/chrome/` and `packages/web/dist/firefox/`, selected via `webpack --env browser=chrome|firefox` (Phase 11) — `package.json`'s `build`/`build:dev` default to Chrome (unchanged from before Phase 11), `build:firefox`/`build:firefox:dev` pass the Firefox flag. Beyond picking the output directory and which `manifests/*.json` gets copied to `manifest.json`, the flag also switches `background.js`'s webpack `target` (`webworker` for Chrome's service worker vs. `web` for Firefox's persistent background page, §9.1) — everything else about the six bundles is identical between targets. `lint:firefox` builds the Firefox target and runs `web-ext lint` against it (Mozilla's own static analyzer, a real `devDependency` — §12's Phase 11 note has what it caught). WASM files copy verbatim to `dist/<target>/wasm/argon2/` — do not bundle them. Copied from the `argon2-browser` dependency's own `dist/argon2.{js,wasm}` in `node_modules` at build time, not from a vendored copy in the source tree (§2.4) — see the `webpack.config.js` note there for why.

> ⚠️ Never include source maps in production builds. They expose implementation structure.

### 10.2 Testing Strategy

The crypto and KDBX tests are the only critical-path tests. Do not proceed to Phase 3 without them passing. Crypto/KDBX/generator/TOTP/health/import tests run against `@keetar/core` in Node via `vitest` — no browser required. Autofill matcher and platform-shim tests run against `@keetar/web`.

**Crypto tests — use official KeePass test vectors:**
- The KeePassXC repository publishes test `.kdbx` files with known passwords. Decrypt them and verify entry data matches expected values exactly.
- Test against KDBX4 test vectors. Also add a negative test: feed a KDBX3 test file through the parser and verify it's rejected with the "unsupported database version" error from §3.2, not a crash or generic parse failure.
- Test vectors are at: `https://github.com/keepassxreboot/keepassxc/tree/develop/tests/data`

**KDBX round-trip test:**
```
1. Open a real KeePassXC-generated .kdbx file
2. Decrypt with known password
3. Modify an entry value
4. Re-encrypt to a new file
5. Re-open the new file and verify the modified value is correct
6. Open the new file in KeePassXC desktop — must open without errors
```

**Autofill matcher tests — table-driven:**

```js
const cases = [
  { entryUrl: 'https://accounts.google.com', tabUrl: 'https://accounts.google.com',       expectedTier: 1 },
  // Corrected from an earlier draft, which paired this entryUrl against
  // 'https://accounts.google.com/login' and expected tier 1 — that pair
  // actually lands on tier 2 (same hostname, different path: 'login' vs
  // none), not tier 1 (exact URL string equality). Kept below as its own
  // case precisely to pin that distinction, since it's an easy one to get
  // wrong when implementing this table.
  { entryUrl: 'https://accounts.google.com', tabUrl: 'https://accounts.google.com/login', expectedTier: 2 },
  { entryUrl: 'https://accounts.google.com', tabUrl: 'https://mail.google.com',            expectedTier: 3 },
  { entryUrl: 'https://google.com',          tabUrl: 'https://mail.google.com',            expectedTier: 3 },
  { entryUrl: 'https://github.com',          tabUrl: 'https://gitlab.com',                 expectedTier: null },
  // ... expand to 30+ cases covering subdomain, TLD, multi-URL fields
];
```

**Other tests:**
- TOTP: verify output matches Google Authenticator for 5+ known TOTP secrets
- HIBP: mock the API, verify correct k-anonymity prefix is sent, correct breach detection
- Provider sync (once §7.3 starts): mock fetch layer, test conflict detection and offline queue logic

---

## 11. Security Model & Threat Mitigations

### 11.1 Asset Protection

| Asset | Where it lives | Protection |
|---|---|---|
| Master password | Never stored | Derived each session, discarded after key derivation |
| Derived session key | Service worker memory only | Overwritten on lock. Lost if SW killed — correct behaviour. |
| Decrypted entry tree | Service worker memory only | Never written to any storage in plaintext |
| Serialized file handle (local-file backend) | `chrome.storage.local` | Not vault content — a reference only. Access still gated by the browser's own File System Access permission model, which lapses on restart (§4.2). |
| Cloud OAuth tokens (once §7.3 ships) | OPFS | AES-256-GCM encrypted. Not in `chrome.storage`. |
| Wrapped session key | OPFS `/session-<uuid>.bin` | AES-KW envelope. Only openable via live biometric assertion. |
| KDBX blob (cloud-backed vaults only) | OPFS `/vault-<uuid>.kdbx` | Encrypted at rest — same security as file on disk. Local-file-backed vaults have no OPFS copy (§4.1). |
| Key file bytes | OPFS `/keyfile-<uuid>.bin` | AES-256-GCM encrypted with device secret |

### 11.2 Content Script Security

The content script runs inside web pages and must be treated as potentially compromised:

- Content script receives only the specific credential needed for the current fill — **never** the full entry tree
- Communication is via `chrome.runtime.sendMessage` — browser origin-checks all messages
- Background validates that the requesting tab URL matches the credential URL before sending anything
- Content script cannot initiate vault access — it can only signal "login form present"

### 11.3 HIBP k-Anonymity

Never send a full password or full password hash to any external API.

```
1. Compute SHA-1(plaintext_password) — in memory only
2. Send GET https://api.pwnedpasswords.com/range/{first_5_hex_chars}
3. Response contains all hash suffixes matching that prefix (~500 entries)
4. Check locally: does SHA1_hex[5:] appear in the response?
5. If yes: password is breached. Report count from response.
```

The plaintext password and full hash never leave the extension.

### 11.4 Content Security Policy

MV3 extensions have a strict CSP that blocks `eval()` and inline scripts. Verify WASM loading is compliant:

- Load argon2 WASM via `importScripts()` in the service worker, not dynamic `import()`
- Do not use `eval()`, `new Function()`, or inline `<script>` tags anywhere
- Webpack output must be CSP-compliant — check `unsafe-eval` is not required

### 11.5 Known Limitations (Do Not Attempt to Solve)

- **SW termination (Chrome MV3):** If the service worker is killed mid-session, the session key is lost. Mitigated by keepalive but not eliminable. This is a platform constraint.
- **No file-change notifications (local-file backend):** The File System Access API can't tell us the file changed underneath us. Mitigated by re-reading on every unlock (§4.2), not eliminable.
- **Memory inspection:** A sufficiently privileged OS process can read extension memory. Same threat model as any password manager. Out of scope.
- **Compromised extension update:** A malicious update would have full access. Mitigated by Chrome Web Store and Firefox AMO code signing + open-source auditing.

---

## 12. Implementation Phases

Build in this exact order. Each phase has a testable stopping point. Do not start a phase until the previous is complete and its tests pass.

| Phase | Focus | Completion criteria |
|---|---|---|
| **1** | Crypto engine + KDBX parser (`@keetar/core`) | `crypto/` and `kdbx/` pass all official KeePass test vectors, in Node, no browser. Test harness only. |
| **2** | Local-file backend + vault session (`@keetar/web`) | Open a real local `.kdbx` file via the File System Access API, decrypt, hold in memory, lock on idle timeout. Browser console or minimal UI only — in practice this still needs *some* page: `showOpenFilePicker()` requires an active document with a user gesture, which a service worker doesn't have. `src/dev-harness/` fills that gap. Its unlock/view-content responsibility moved to the real Popup once Phase 3 built it; it now stands in only for Options' file-selection piece (§8.2), which doesn't have a real home yet, and should be deleted once Options exists for real. |
| **3** | Popup UI (read-only) | Show entry list, search, copy username/password to clipboard. No editing, no autofill yet. Built as a locked/unlocked state machine (`App.tsx`) — Popup is the surface that actually prompts for the master password (§4.2, §6.2's "open extension → ... → vault open" describes this gesture), even though §8.1 frames it as "post-unlock": that's its primary/steady-state content, not its only state. `GET_ENTRY_FIELD` returns one field's plaintext at a time, on demand, rather than handing the popup the full entry set — the same "give a surface only what it needs, when it needs it" instinct §5.1 applies to content scripts, applied here even though Popup is trusted (not hostile) — no reason to hold more decrypted material in the popup's own memory than the current action requires. |
| **4** | Autofill | Content script + domain matching + credential injection. Test manually on 10 real sites including Google and GitHub. §5.4's "auto-fill on single match" behavior needs a real preference (idle-timeout-style settings, which live in Options — §8.2) that doesn't exist yet; until Options is built, a single match still only sets the toolbar badge rather than filling automatically — Popup's existing entry list (Phase 3) gained a "Fill" button per row instead of a separate match-list surface, with matched entries sorted to the top. Not verified against any real site yet — that's on whoever's driving a real browser. |
| **5** | Write path | `kdbx-format.ts`'s `save()`/`saveV4()` (§2.7 — per-object-model split, not a separate `writer.ts`) — add, edit, delete entries, save back to the local file handle. **Critical:** output must open in KeePassXC desktop without errors — not yet verified against the real desktop app; that needs a real machine with KeePassXC installed. `vault-session.ts` gained `createEntry`/`updateEntry`/`deleteEntry`, each auto-saving per §14's decision. No new UI: Manager (Phase 6) is where create/edit/delete actually get a surface — Popup doesn't own editing (§8.2) — so the write path is exercised manually via the service worker's own console (`__keetarDebug.vaultSession`, exposed for exactly this) until then. |
| **6** | Manager UI | Full vault-content management surface (§8), post-unlock only: entry editing, group management, attachments, wired to the write path from Phase 5. Three-pane layout (group tree / entry list / entry detail); fields auto-save on blur, not per-keystroke, consistent with §14's "save on mutation" decision without re-serializing the whole tree on every character typed. Manager has no unlock flow of its own — it shares Popup's background session (§8.1), so opening it while locked just points the user back at Popup rather than duplicating password entry. TOTP secret setup, import/export, and conflict resolution — also listed under §8.2's Manager ownership — stay out of scope here; those are Phases 8–10's own work, not implied by "wired to the write path." |
| **7** | Biometric unlock | WebAuthn PRF enrolment and unlock, folded into the same gesture as file-handle re-grant (§6.2). Requires real device testing — Touch ID, Windows Hello, and at least one FIDO2 hardware key — none of which is available from here; nothing about this phase's actual crypto/WebAuthn plumbing has been exercised against real hardware. See §6.2's note for a real design deviation made along the way (AES-KW wraps `KdbxCredentials.passwordHash`, not the derived session key — a deliberate choice to avoid touching core's decrypt pipeline, made together rather than assumed). §6.4's WebHID YubiKey HMAC-SHA1 mode is explicitly out of scope here — it's a separate legacy code path from FIDO2 (which *is* covered, via the same WebAuthn PRF flow as biometric unlock per §6.1), not implied by this phase's stated criteria. Options (§8.2) is now a real, permanent surface — file selection moved out of `src/dev-harness/`, which is now deleted, its purpose fully absorbed. |
| **8** | TOTP + health | TOTP generation + autofill, HIBP breach checking, password health report (weak, reused, old, breached). |
| **9** | Import / export | CSV, Bitwarden JSON, 1Password 1PUX, Proton Pass JSON. Export to CSV and XML. Parsing/serializing lives in `@keetar/core`'s `import/` (§2.4) as pure functions over a generic `VaultEntryRecord` shape — isomorphic, tested in Node like the rest of Phase 1 (§10.2), with no Kdbx instance involved. `vault-session.ts` (§9's only web-side write logic) turns records into real entries via the same `db.createEntry`/`db.createGroup` calls Phases 5–6 already use, resolving each record's `'/'`-separated group path under the caller-chosen target group (creating folders as needed, reusing them by name on re-import) rather than requiring a flat drop. 1PUX parsing needed unzipping, not just `JSON.parse` — it's a zip archive containing `export.data`; `fflate` (already a dependency for KDBX's own gzip framing) covers zip too, so no new dependency. Bitwarden/1Password/Proton Pass parsers degrade gracefully on fields that don't match the documented schema (fold into Notes, or skip) rather than throwing, since real export files across app versions are the actual input — not something to assume from documentation alone; Phase 12's beta loop is where that assumption first gets tested against real exports. Import/export both got a UI panel in Manager (§8.2's existing ownership) — format picker + file input for import, two buttons for export — rather than a separate surface. **Addendum — Combine Vaults** (requested after the phase's initial build, not in the original scope above): folds a *second*, independently-encrypted `.kdbx` file into the current one, for the case a format importer doesn't cover — two real KeePass vaults with no shared lineage. This is deliberately not `Kdbx.merge()` (§4.3's CRDT sync-reconciliation, which requires both sides to share a root group UUID — i.e. two replicas of the *same* database being reconciled, not two independently-created ones); `Kdbx.merge()` would simply throw `'default group is different'` here. Instead, `vault-session.ts` holds the second file as its own separate in-memory `Kdbx` (`openSecondaryVault`/`closeSecondaryVault`), walks both trees into `VaultEntryRecord`s carrying their live entry UUID, and hands them to `dedup.ts` (new — see §2.4's `background/` listing) to group likely duplicates. Since neither vault has any lineage to compare, identity has to be a heuristic: **username + the URL's core domain label** (tldts' `domainWithoutSuffix` — `https://login.example.co.uk` and `example.com` both reduce to `example`, ignoring scheme, subdomain, and public suffix), a deliberately looser match than autofill's own tiered algorithm (§5.4) because the goal here is surfacing *candidates* for a human decision, not silently auto-filling. Entries with no key on either side (missing username or unparseable URL) never form a group and always import untouched — matching Phase 9's own default of only asking about genuine conflicts. Every remaining conflict group defaults to "keep existing" in the Manager review panel, so ignoring the panel never overwrites anything; the three resolutions are keep-existing, keep-incoming, and keep-both (for a false-positive match: two real, different accounts that happened to share a key). A matched group also carries a second signal — password equality — so **combining two snapshots of the same evolving database** (an old backup plus a current copy someone kept adding to) doesn't mean reviewing every unchanged entry: `dedup.ts`'s `partitionByPasswordMatch` treats a clean 1-to-1 match with an identical password as genuinely the same, unmodified entry and resolves it automatically (excluded from the auto-import count too, since importing it again would just duplicate what's already there); only groups where the password actually diverged, or where the pairing is ambiguous (more than one entry sharing a key on either side — real ambiguity, not guessed away), still surface as conflicts needing a real decision. The review screen's summary line reports the auto-resolved count separately so combining isn't a black box. **Merging is additive, not a whole-entry pick**: keep-existing/keep-incoming no longer mean "one side's entry wins outright and the other's information is discarded" — for a clean 1:1 matched pair (identical or divergent), `mergeRecordIntoEntry` mutates the *existing* primary `KdbxEntry` in place field-by-field via `dedup.ts`'s `mergeStringField`/`mergeIcon`: an empty field on either side always yields to a populated one (title/username/password/url/notes/TOTP secret; tags union as a set instead of picking a side, since more tags is strictly more informative, never a real conflict), and only a genuine populated-vs-populated disagreement falls back to the chosen resolution's direction — which is also how the password itself gets resolved, so there's one merge rule, not a special case for password plus separate handling for everything else. Mutating in place rather than deleting-and-recreating is what makes this additive for everything the flat `VaultEntryRecord` shape doesn't even represent (`autoType`, history, custom icon — still out of scope, see below) — none of it is touched, so it survives untouched on whichever side's entry was kept. `VaultEntryRecord` gained one field for this: `icon` (KeePass's built-in, fixed icon-index enum — standardized across clients, so meaningful to compare across independently-created vaults, unlike a custom uploaded icon image, which stays out of scope, see below). Icon 0 is every entry's default at creation, so it's treated as "unset" for merge purposes, not a real value that could win a conflict. `icon` is combine-vaults-only for now — the CSV/Bitwarden/1Password/Proton Pass importers and CSV/XML exporters have no equivalent concept and don't read or write it. A group with real multiplicity (more than one entry sharing a key on either side) has no unambiguous pairing to merge into, so it falls back to the older whole-entry behavior instead of guessing: keep-existing is a no-op, keep-incoming removes every matched primary entry and imports every secondary one fresh (its attachments included — see below). **Attachments merge too**, unlike `icon`, without needing any new field on `VaultEntryRecord` at all: `copyAttachments` works directly off the live secondary `KdbxEntry` (which the merge/import call sites in `applyCombine` now look up via `findEntry` on the still-open secondary `Kdbx`, alongside the already-flattened record) rather than routing through the generic record shape the way every other merged field does. Every one of the secondary entry's attachments the primary doesn't already have by name gets added via `db.createBinary()` — the same call `addAttachment()` uses, which already hashes and dedupes internally, so this needed no new dedup logic the way a future custom-icon merge would. A same-name collision falls back to the resolution direction, consistent with every other field. Custom icon images remain the one deliberately deferred piece — copying them means reconciling each vault's own separate `meta.customIcons` map, which (unlike binaries) has no existing hash-based dedup, so a naive copy would duplicate the same image on every combine; that's a follow-up, not attempted here. **Addendum — icon rendering + on-demand favicons** (a direct follow-up to the `icon` field added above): until now `icon`/`customIcon` were pure bookkeeping — nothing in Popup or Manager rendered either one, entries were plain text rows. `EntryIcon.tsx` (new — `ui/shared/`, §2.4) closes that gap for both sources. The built-in icon (KeePass's fixed 0-68 index) is a static asset lookup, `icons/{index}.png`, sourced by hand into `assets/icons/` rather than vendored — no image set for that fixed bank ships with `@keetar/core` or `keewebx` (§2.7), and none was found to vendor from. Nothing about that is a hard dependency, though: `noErrorOnMissing` on the copy pattern means the build never fails whether the set is complete, partial, or entirely absent, and `EntryIcon.tsx`'s `onError` handler falls back to a generic placeholder per-index at runtime for whatever isn't there — so the feature ships and degrades gracefully independent of when the actual images get sourced. Custom icons (real vault data — either a manually uploaded image, unaffected by anything here, or the new favicon-download path) are fetched on demand via `GET_ENTRY_CUSTOM_ICON`, same reasoning as attachments (§9 above): binary data doesn't belong in every `EntrySummary`/`EntryDetail` response, only when something actually wants to render it. Downloading a favicon (`favicon.ts`, new) tries `{origin}/favicon.ico` then `{origin}/favicon.png`, decodes whatever comes back via `createImageBitmap()`, and re-encodes to PNG via `OffscreenCanvas` — normalizing to one stored format regardless of source (`.ico` is a container format with possibly several embedded sizes; `createImageBitmap` picks a reasonable one automatically, no manual ICO parsing needed) rather than trusting every KeePass-compatible client to render a raw `.ico`. All three of `fetch`/`createImageBitmap`/`OffscreenCanvas` are available in a Chrome MV3 service worker (unlike `document` — no page or content-script round trip needed, unlike the File System Access API back in §2.4/§4.2) and in a Firefox MV2 background page, so `vault-session.ts`'s `setCustomIconFromFavicon` stays entirely background-side like every other write path here. It mints a fresh `KdbxUuid` per download rather than checking for an existing identical icon first — `meta.customIcons` has no hash-based dedup the way `KdbxBinaries` does (the same gap that deferred custom-icon *copying* out of Combine Vaults, above); an occasional duplicate only happens when two entries share the same origin, a bounded case, unlike blindly re-importing a whole foreign vault's icon set the way Combine Vaults would have to. **Addendum — bulk favicon fetch**: `fetchMissingFavicons` (`vault-session.ts`) is the "do this for the whole vault" counterpart to the single-entry button — every entry with a URL and no custom icon yet, in one Manager action ("Fetch Favicons," next to Health/Import-Export/Combine Vaults). It persists once at the end rather than per entry (still one mutation under §14's auto-save rule, just covering many entries — the same batching `applyCombine` already does), and a single entry's failure (no favicon found, network error, site down) is counted and skipped rather than aborting the rest, unlike the single-entry path, where a failure surfaces directly to the caller. Fetches run through `runWithConcurrency` (new, `vault-session.ts`) with a fixed worker-pool limit of 10 rather than either extreme: fully sequential would mean one network round-trip per site for a potentially large vault, fully parallel would fire every entry's fetch at once. 10 leans toward the parallel side deliberately — these are distinct origins, not one host being hammered, so the usual per-host connection ceiling barely applies, and the work itself (a short round-trip plus a fast decode/re-encode of a small image) is I/O-bound, not CPU-bound; going much higher (tens of simultaneous requests to arbitrary third-party sites within the same second) would be a burst a single user action has no real need to produce, but 10 is comfortably short of that. |
| **10** | Cloud providers (§7.3) | Google Drive first (largest user base), then Dropbox, then OneDrive — Dropbox/OneDrive not started yet; this row covers Google Drive. `providers/oauth-pkce.ts` (provider-agnostic PKCE via `identity.launchWebAuthFlow`, §9.2), `providers/oauth-token-store.ts` + `storage/device-secret.ts` (encrypted-at-rest OAuth tokens, §4.1), and `providers/gdrive.ts` (Drive REST API v3) together form the `FileProvider` implementation; `providers/index.ts`'s `createFileProvider` is the one place `ConfiguredVault.provider` maps to a concrete provider, keeping `vault-session.ts` itself provider-agnostic per §7.1. A correction to this doc's own earlier assumption surfaced while building this: `drive.file` scope can't list/browse the user's existing Drive files itself — only files the app created, or files the user hands it through Google's Picker widget (even ones the app didn't create). File selection therefore goes through the real Google Picker widget, its JS loaded via `google-picker-offline-loader` (an extracted package, `providers/gdrive-picker.ts` its thin Drive-specific wrapper) rather than fetched live from Google at runtime — see Phase 11's addendum below for why that approach (not the sandboxed-page bridge an earlier draft of this row described) is what actually shipped. **Addendum — §4.3 sync + vault creation** (chat-requested, tackled right after this phase's first pass): §4.3's full OPFS-cache/offline-sync algorithm is now built, as `providers/opfs-cache.ts`'s `OpfsCachedProvider` — see §4.3's own writeup for the read/write/conflict-resolution behavior; `createFileProvider` (`providers/index.ts`) wraps Google Drive in it automatically. Vault *creation* also now exists — previously no backend had it, including local-file, which only ever opened an existing file. `providers/vault-creation.ts`'s `createEmptyVaultBytes` (`Kdbx.create()` + `save()`) is backend-agnostic; Options' new "Create a new vault" section takes a name, password (with confirmation), and a backend choice, then hands the resulting bytes to either `local-file.ts`'s new `createVaultFile` (`showSaveFilePicker()`, the save-dialog counterpart to `pickVaultFile`'s open-dialog) or `GoogleDriveProvider.createFile()` (built in this phase's first pass but unused until now). What Options supports overall: connecting/disconnecting a Drive account, picking an existing `.kdbx` from Drive via the Picker, uploading the currently-open local vault's raw bytes into a new Drive file to switch backends, creating a brand-new vault on either backend, and — new — a "Sync status" section that proactively checks for and resolves a §4.3 step-3c conflict (whole-file "keep this device's copy" / "keep Google Drive's copy," not a field-level merge — see §4.3's note on why that's different from Combine Vaults' §9 approach). Popup also distinguishes a sync-conflict unlock failure from any other error now (`message-bus.ts`'s `code: 'SYNC_CONFLICT'`), pointing the user at Options instead of just showing a generic message. A real Google Cloud OAuth Client ID and Picker API key were required for any of this to actually run — both now filled into `gdrive.ts`, §7.3's "Google Cloud Console Setup" walkthrough having been done by hand (nothing about that step could be automated); see §7.3's own note on the one surprise it turned up (Firefox's default redirect domain, expected to need a loopback-address workaround per Mozilla's docs, saved in Google's console without issue when actually tested). The Picker's interactive `setVisible(true)` flow is consequently no longer a documented unverified gap (§11.4's own earlier note) — real credentials now exist to test it, though that live end-to-end test hasn't happened in this conversation itself. |
| **11** | Firefox + polish | **Started.** `manifests/manifest.firefox.json` (MV2) now exists; `webpack.config.js` takes a `--env browser=firefox` flag (new `build:firefox`/`build:firefox:dev` scripts) building to `dist/firefox/` in parallel with `dist/chrome/`, picking `target: 'web'` for `background.js` there instead of Chrome's `target: 'webworker'` — Firefox MV2's background is a persistent *page*, not a service worker (§9.1). That page-vs-worker distinction turned up a real bug, not just a build-config one: `argon2-wasm.ts` loaded its WASM glue via `importScripts()` unconditionally, a `WorkerGlobalScope`-only API that doesn't exist in a page context at all — it now branches on `typeof importScripts === 'function'`, falling back to a plain `<script>` tag append on Firefox. Verification so far is `web-ext lint` (Mozilla's own static analyzer — now a real `devDependency` and a `lint:firefox` script, not a one-off), not a live Firefox session; it caught two more real, fixable issues no amount of reading could have: `chrome.action.setBadgeText` (§5.1's toolbar badge) was hardcoded rather than going through the platform shim, silently doing nothing on Firefox — `action.setBadgeText` is MV3-only, Firefox MV2 calls the same concept `browserAction.setBadgeText`; both `platform/chrome.ts` and `platform/firefox.ts` gained an `action` export to cover it. And the manifest's `browser_specific_settings.gecko.strict_min_version` needed bumping twice — first because `options_page` needs Firefox 126+, then because a newer, separately-required key (`data_collection_permissions`, mandatory for new extensions per current Mozilla policy — declared here as `{"required": ["none"]}`, since nothing here transmits user data anywhere) needs 140+ desktop / 142+ Android — settled on `142.0` to clear both. One `web-ext lint` finding turned out to be a real, significant blocker rather than noise — addressed and resolved below, not just noted; the remaining warnings (several `UNSAFE_VAR_ASSIGNMENT`/`DANGEROUS_EVAL`/repeated `UNSUPPORTED_API` findings, all inside minified vendor code — React-DOM, zxcvbn) are assessed as the tool's own false positives against code this project doesn't control, not chased further. |
|  |  | **A genuine blocker, found here not guessed at, and since resolved**: `web-ext lint` flagged `sandbox/picker.html` with `REMOTE_SCRIPT` — "Remote scripts are not allowed as per the Add-on Policies." Confirmed via Mozilla's own linter, not assumed, that this is a flat categorical prohibition on loading remote code at all in an AMO submission, not a CSP-syntax difference to work around — Chrome MV3's `sandbox.pages` mechanism exists specifically to *permit* remote scripts (with a scoped CSP); Firefox's add-on review process has no equivalent carve-out. Chased two Google-hosted alternatives before landing on the fix: the official Node.js Drive API quickstart bundles no browser-usable Picker equivalent (it's a server-side client library), and the newer `@googleworkspace/drive-picker-element` web component, despite being npm-installable, was confirmed (via its own source) to still fetch `apis.google.com/js/api.js` and `accounts.google.com/gsi/client` live at runtime internally — installing it changes nothing about the remote-script problem. **Resolved by vendoring the Picker's actual JS instead of loading it remotely at all** — a deliberate choice to preserve the `drive.file` OAuth scope (see this doc's own research on the restricted-scope-verification burden the broader `drive` scope would trigger) rather than trade it away for the broader scope's in-app browsing capability, on the basis that Google's Picker terms-of-service language ("not a supported use case" for `accounts.google.com/gsi/client` specifically — no equivalent explicit language found for `apis.google.com/js/api.js`) is not the same thing as a prohibition. `scripts/vendor-picker.mjs` (dev-only, jsdom-based — see §13's row for why a full browser engine wasn't needed here) captures a real `gapi.load('picker', ...)` run against live Google infrastructure, recording both `api.js` and the module URL it dynamically fetches in a second, separate request (confirmed empirically — `gapi.load` is a lazy second-stage loader, not something `api.js` alone serves), then *validates* the capture by replaying it with all network access cut off — no write to the committed `vendor/google-picker/` happens unless that zero-network replay succeeds. `providers/gdrive-picker.ts` loads the vendored files directly and patches `document.createElement`/`setAttribute` to redirect Picker's own dynamically-constructed module request to the vendored copy — validated against real Chromium with all external network blocked (two real bugs surfaced only by this adversarial test, not by the jsdom-based validation alone: api.js uses `setAttribute('src', ...)` for this specific request, not `.src =`, and the value passed isn't a plain string). Confirmed the fix is complete, not partial: `web-ext lint` now shows zero `REMOTE_SCRIPT` findings against the vendored Firefox build. The sandboxed page, its relaxed CSP, and the postMessage bridge to Options were removed entirely (not just repointed at local files) once vendoring made same-origin loading possible — MV3/MV2's default CSP already permits same-origin scripts, so the whole mechanism that only ever existed to permit *remote* loading had nothing left to do. One thing this hasn't resolved: a webpack default-minifier bug where the vendored files were being silently re-minified at build time, shipping different bytes than what `vendor-picker.mjs` validated — fixed via an explicit `terser-webpack-plugin` exclude (§13), re-verified via `sha256sum` that shipped bytes now match the committed, validated files exactly in both browser builds. |
|  |  | **Addendum — extracted to `google-picker-offline-loader`** (chat-requested, right after the above): the vendoring mechanism above — capture, validate, and the runtime DOM-interceptor in `gdrive-picker.ts` — had nothing Keetar-specific about it, so it moved into its own repo/package (github.com/papacodebear/google-picker-offline-loader, MIT-licensed, dated `YYYY.M.D` versions rather than semver, since most releases are just a re-validated capture) rather than staying duplicated logic here. `providers/gdrive-picker.ts` shrank to a thin wrapper around that package's `loadGooglePicker()`; this repo's own `vendor/google-picker/` and `scripts/vendor-picker.mjs` were deleted outright. The intended path was a real npm-registry publish (CalVer made that clean — bump the version, consumers get a fresher capture), but the publishing account couldn't complete npm's required OTP/2FA step for the actual `npm publish` (blocked on setting up a hardware security key — notably, the exact kind of authenticator this project's own §6.2 WebAuthn PRF work is about). Landed instead on a `github:` git-protocol dependency pinned to an exact commit SHA (`packages/web/package.json`'s `google-picker-offline-loader` entry), which needed two adjustments beyond a normal dependency: the package gained a `prepare` script (`tsc`) so a git-sourced install — which gets the raw repo, not an npm-published tarball with `dist/` already built — produces working JS on install; and `pnpm-workspace.yaml` needed a matching `allowBuilds` entry, since pnpm blocks any package's install-time build scripts by default as a supply-chain safeguard. Revisit the registry publish once real 2FA is set up — nothing else about the setup needs to change, only the dependency line moving from a pinned git commit to a normal version range. |
|  |  | **Still outstanding for this phase**: no live Firefox session has run any of this — `web-ext lint` is static analysis, not a functional test (Phase 12's beta loop, or an earlier manual check, is where that first happens, same as every other "reasoned through, not observed working" flag elsewhere in this project). The `UNSUPPORTED_API`/`DANGEROUS_EVAL`/`UNSAFE_VAR_ASSIGNMENT` findings still showing across most bundles are, on inspection, a linting artifact rather than a real defect: `platform/index.ts` statically imports *both* `chrome.ts` and `firefox.ts` (deliberately, so the service worker bundle doesn't depend on runtime code-splitting — see that file's own comment), so the Chrome shim's dead-on-Firefox `chrome.action.setBadgeText` text is still physically present in every bundle that imports anything from `platform/`, which `web-ext`'s regex-based scanner flags regardless of whether that branch can actually execute; `UNSAFE_VAR_ASSIGNMENT`/`DANGEROUS_EVAL` likewise trace to minified React-DOM/zxcvbn vendor code, not anything authored here. None of these were chased further — flagged as assessed-and-set-aside, not silently ignored. |
| **12** | Beta feedback loop | Not a fixed scope like the phases above — an open-ended loop, run for as long as testing keeps finding things worth fixing. Solo dogfooding to start: run it against real, existing, pre-Keetar KeePass databases (not fresh test vaults) on a real machine — the first real-world exposure for everything Phases 1–11 could only reason about or unit-test from here. Widening to other testers, if it happens, is a separate later call, not assumed here. Expect: UI rough edges surfaced by actual daily use, bugs specific to real vaults/sites/hardware no test suite caught, and last-mile feature requests worth doing before a public release but not worth guessing at upfront. Fix and iterate; repeat until the loop stops turning up must-fix issues. **Only then** submit to the Chrome Web Store and Firefox AMO — store review turnaround makes shipping fixes slow and public, so this loop is what happens *before* that, not after. |

---

## 13. Dependencies & Rationale

| Package | Version | Rationale |
|---|---|---|
| `typescript` | `~5.9.0` in `@keetar/core` | Strict typing across both packages — a stated primary goal (§1.1). All source files are `.ts`/`.tsx` (§2.4). Initially pinned to `~5.6.0` to match the minor version keewebx's bootstrapped `crypto/`/`kdbx/` source (§2.7) was actually built and typechecked against, since TS 5.7+ made typed arrays generic over their buffer type (`Uint8Array<ArrayBuffer>` vs. the old bare `Uint8Array`), breaking structural compatibility throughout that code for no behavioral reason. Deliberately upgraded to `5.9.3` (latest of the mature JS-based compiler line — TS jumped straight from 5.9 to a `7.0` native Go rewrite, too fresh/unproven a jump to take alongside this work) and the ~80 resulting error sites fixed directly: pinned `Uint8Array`-returning helpers in `byte-utils.ts` to `Uint8Array<ArrayBuffer>`, widened a few pervasively-used signatures (`CryptoEngine`'s `BufferLike = ArrayBuffer \| Uint8Array<ArrayBuffer>` param type, `VarDictionaryAnyValue`) to match what their runtime code already accepted, and wrapped remaining call sites with the existing `arrayToBuffer()` helper. `CryptoEngine.random()` changed from returning `Uint8Array` to `ArrayBuffer` (its callers overwhelmingly wanted the latter; the few needing indexed byte access now wrap explicitly). Stay current with the 5.9.x line going forward; revisit TS 7 as its own deliberate, separately-verified upgrade once its toolchain ecosystem (vitest, ts-loader) is proven. |
| `argon2-browser` | latest | WASM Argon2id — no in-browser alternative exists. Use WASM build, not JS fallback. Loaded directly against its low-level WASM `Module` rather than through its public `hash()` wrapper in both places it's used, not just one: `@keetar/core`'s test-only Argon2 implementation (§2.7) via Node's `createRequire`, and `@keetar/web`'s real runtime implementation (`background/argon2-wasm.ts`) via `importScripts()` (§3.1, §11.4) — the public wrapper hardcodes Argon2 version 0x13 and only accepts UTF-8 string input, but real KDBX4 files can specify version 0x10 and our composite key/salt are raw bytes. |
| `@stablelib/chacha` | latest | ChaCha20 inner stream for KDBX4 (package name is `@stablelib/chacha`, not `@stablelib/chacha20` — see §3.1). Audited, minimal, TS types. Swapped in for keewebx's own hand-rolled ChaCha20 implementation during the §2.7 bootstrap. |
| `@xmldom/xmldom` | latest | DOM-compliant XML parser for non-DOM environments (service worker, Node tests). See §3.1. |
| `tldts` | latest | TLD-aware domain parsing. ~10KB. Required for correct base-domain matching across all public suffixes. |
| `fflate` | latest | DEFLATE for KDBX payload blocks. ~8KB gzipped. Faster and smaller than pako. Zip support (`unzipSync`/`zipSync`) reused for 1PUX import (§9) instead of adding a separate zip library. |
| `react` + `react-dom` | 18.x | Popup, manager, and options UI only. Not loaded in background or content scripts. |
| `zxcvbn` | latest | Password strength estimation — same library KeePassXC uses. Load lazily in generator UI only. |
| `webpack` + `ts-loader` | latest | Build tooling (`@keetar/web`). `ts-loader` alone compiles TypeScript directly (typechecked, via the real `tsc` program) — no `babel-preset-typescript` needed on top of it. Two separate webpack configs, not one multi-entry config: the service worker bundle (`target: 'webworker'`) and extension-page bundles (`target: 'web'`) need incompatible globals (no `document` in the former, no worker-only APIs assumed in the latter), and webpack's `target` is config-wide, not per-entry. Not bundled into extension output. |
| `copy-webpack-plugin` | latest | Copies `manifests/*.json` → `manifest.json`, `argon2-browser`'s `dist/argon2.{js,wasm}` from `node_modules` → `wasm/argon2/` (§10.1 — WASM files copy verbatim, never bundled, and not vendored in the source tree — §2.4), and extension-page HTML into each build target's output directory. |
| `@types/chrome` | latest | Ambient types for `chrome.*` APIs (storage, idle, alarms, runtime). |
| `web-ext` | `^10.6.0` | Mozilla's own extension linter/dev-tool (Phase 11, §9, §12) — `lint:firefox` runs its static analyzer against the built Firefox bundle. Caught real, otherwise-invisible-from-here issues no amount of reading the manifest schema could have: `action.setBadgeText` silently unsupported on Firefox (needed `browserAction` instead), two rounds of `strict_min_version` being too low for keys actually in use, and — initially, before it was fixed — that the Google Picker widget's live remote script load couldn't ship in a Firefox build at all under Mozilla's Add-on Policies (`REMOTE_SCRIPT`). That finding drove the switch to vendoring (§7.3, §11.4) rather than being worked around with different CSP syntax, since Mozilla's prohibition is on remote code categorically, not a schema difference; `lint:firefox` now runs clean (zero `REMOTE_SCRIPT` findings) against the vendored build. Static analysis only; not a substitute for testing against a real Firefox session. |
| `google-picker-offline-loader` | `github:papacodebear/google-picker-offline-loader#<pinned commit>` | Loads Google's Picker widget from vendored local files instead of live from `apis.google.com` (§7.3, §11.4) — extracted from this project into its own MIT-licensed package, since the mechanism (capture + validate Picker's JS ahead of time, redirect its runtime module-loading at the DOM level) had nothing Keetar-specific about it. A `github:` git-protocol dependency pinned to an exact commit, not a normal registry version range — the intended real npm-registry publish is blocked on the publishing account completing npm's required 2FA/OTP step, itself blocked on the hardware security key this project's own §6.2 work is about. Its `prepare` script (plain `tsc`) needs `pnpm-workspace.yaml`'s `allowBuilds` allowlist (§2.4) to run at all, since pnpm blocks install-time build scripts by default. Revisit the registry publish, and drop the pin for a normal version range, once real 2FA is available. |
| `terser-webpack-plugin` | `^5.6.1` | Dev-only. Webpack's default production minimizer applies to every emitted `.js` asset by extension, including ones `copy-webpack-plugin` copies in verbatim — found the hard way, via a `sha256sum` mismatch between the committed vendored Picker files and what actually shipped in `dist/`. Configured explicitly on the `options` bundle with an `exclude: /vendor[\\/]google-picker/` pattern so those files ship as the exact bytes `google-picker-offline-loader` validated, while everything else in that bundle still gets minified normally. |
| `@types/wicg-file-system-access` | latest | Ambient types for the File System Access API (`showOpenFilePicker`, `FileSystemFileHandle`, `queryPermission`/`requestPermission`) — not yet part of TypeScript's bundled DOM lib. |
| `vitest` | latest | Unit testing across both packages. Not bundled into extension output. |

> ⚠️ **Rule for adding any new dependency:** audit it for network requests at import time. Any dependency that phones home at load is disqualifying. All network activity in this extension must be explicit and user-initiated.

---

## 14. Open Decisions for Implementation

These are not blocking issues but should be resolved early in the relevant phase. Do not guess — raise them for a decision.

**Password generator default** — Characters or words? KeePassXC defaults to characters. Recommendation: character-based default with a toggle to passphrase mode, configurable per-entry. Decide in Phase 3.


