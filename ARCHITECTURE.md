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
│   │   │   │   └── session-key.ts     # AES-KW wrap/unwrap of the session key, given VUK bytes
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
│   │   │       ├── csv.ts             # Generic CSV + KeePass CSV format
│   │   │       ├── bitwarden.ts       # Bitwarden JSON export format
│   │   │       ├── onepassword.ts     # 1Password 1PUX format
│   │   │       └── protonpass.ts      # Proton Pass JSON export format
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
│       │   │   ├── message-bus.ts     # Typed message router between popup/manager/content/background
│       │   │   └── argon2-wasm.ts     # Wires argon2-browser's WASM Module into CryptoEngine (§3.1, §11.4)
│       │   ├── providers/
│       │   │   ├── local-file.ts      # File System Access API — near-term primary backend
│       │   │   ├── opfs-cache.ts      # OPFS — cache layer for cloud-backed vaults (deferred use)
│       │   │   ├── gdrive.ts          # Deferred — Google Drive OAuth2 + Drive REST API v3
│       │   │   ├── dropbox.ts         # Deferred — Dropbox OAuth2 + Dropbox API v2
│       │   │   └── onedrive.ts        # Deferred — OneDrive OAuth2 + MS Graph API
│       │   ├── auth/
│       │   │   ├── webauthn.ts        # WebAuthn credential registration + assertion
│       │   │   ├── prf.ts             # PRF extension — derive VUK from authenticator output
│       │   │   └── biometric.ts       # Enrol + unlock flow orchestration
│       │   ├── autofill/
│       │   │   ├── content.ts         # Content script: detect login forms, receive fill msg
│       │   │   ├── detector.ts        # DOM heuristics for username/password field pairs
│       │   │   ├── filler.ts          # Credential injection compatible with React/Vue/Angular
│       │   │   └── matcher.ts         # Domain matching: exact → hostname → base domain → title
│       │   ├── ui/
│       │   │   ├── popup/             # Quick-access UI, post-unlock — see §8
│       │   │   ├── manager/           # Vault-content management UI, post-unlock only — see §8
│       │   │   └── options/           # Setup + config, reachable pre-unlock — see §8
│       │   └── platform/
│       │       ├── chrome.ts          # Chrome-specific: MV3 service worker, chrome.identity
│       │       ├── firefox.ts         # Firefox-specific: MV2 background page, browser.identity
│       │       └── index.ts           # Re-exports correct shim based on build target
│       ├── manifests/
│       │   ├── manifest.chrome.json   # MV3
│       │   └── manifest.firefox.json  # MV2 (MV3 target added in Phase 11)
│       ├── build/
│       │   └── webpack.config.js      # copies argon2-browser's dist/argon2.{js,wasm} from
│       │                              # node_modules into dist/<target>/wasm/argon2/ at build
│       │                              # time (§10.1) — not vendored in the source tree. A
│       │                              # vendored copy could silently drift from whatever
│       │                              # version package.json/pnpm-lock.yaml actually pin;
│       │                              # copying from the resolved dependency at build time
│       │                              # can't.
│       ├── tests/
│       ├── package.json               # @keetar/web
│       └── tsconfig.json
│
├── package.json                       # workspace root
├── tsconfig.json                      # base config, extended by packages
├── pnpm-workspace.yaml
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
| `fflate` | DEFLATE compression/decompression for KDBX payload blocks. Smaller and faster than pako. |

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

The derived cipher key (output of step 6 above) is the session key. It lives **only** in service worker module-level memory (`@keetar/web`), wrapped/unwrapped via `@keetar/core`'s `session-key.ts`.

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
                             every unlock instead (§4.2) and are never cached here.
/vault-<uuid>.meta.json      { provider, filePath, lastModified, eTag } — cloud vaults only
/session-<uuid>.bin          AES-KW wrapped session key (32 bytes → 40 bytes encrypted) — all backends
/biometric-<uuid>.json       { credentialId, prfSalt, enrolledAt } — WebAuthn public info, all backends
/keysalt-<uuid>.bin          Random 32-byte salt used as PRF eval input during biometric auth
/keyfile-<uuid>.bin          Key file bytes encrypted with AES-256-GCM + device secret
/device-secret.bin           Random 256-bit device-local secret (protects key file at rest)
/settings.json               UI preferences, idle timeout, autofill config — no key material
```

**UUID derivation:** Use `SHA-256(provider + ":" + filePath)` truncated to 16 bytes, hex-encoded. Stable across sessions for the same vault, and shared between the local-file and cloud backends so switching a vault between them later doesn't orphan its auth state.

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

**Enrollment:**

```
1. Generate 32-byte random prfSalt
2. Store prfSalt in /keysalt-<uuid>.bin in OPFS
3. Call navigator.credentials.create() with prf extension:
     extensions: { prf: {} }
     user.id = SHA-256(vaultUUID)
4. VUK = assertion.getClientExtensionResults().prf.results.first  (32 bytes)
5. AES-KW wrap the current session key using VUK
6. Store wrapped key in /session-<uuid>.bin
7. Store credentialId in /biometric-<uuid>.json
8. Discard VUK from memory immediately
```

**Unlock:**

```
1. Read prfSalt from /keysalt-<uuid>.bin
2. Read credentialId from /biometric-<uuid>.json
3. Call navigator.credentials.get():
     allowCredentials: [{ id: credentialId, type: 'public-key' }]
     extensions: { prf: { eval: { first: prfSalt } } }
4. OS performs biometric check (Face ID / Touch ID / Windows Hello / YubiKey)
5. VUK = assertion.getClientExtensionResults().prf.results.first
6. AES-KW unwrap /session-<uuid>.bin using VUK → session key in memory
7. Vault is unlocked. Discard VUK immediately.
```

If the active backend is the local-file provider (§4.2), fold `handle.requestPermission()` into the same gesture: biometric/password unlock and file-access re-grant happen as one user interaction, not two.

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

### 7.3 Deferred: Direct Cloud OAuth

**Not in the initial version.** Direct OAuth remains a primary long-term goal (§1.1) but is sequenced after the local-file backend ships and stabilizes.

| Provider | Difficulty | Blocker |
|---|---|---|
| Google Drive | Medium | `chrome.identity.getAuthToken()` covers Chrome; Firefox needs full PKCE |
| Dropbox | Medium | Clean PKCE REST API; friction is extension redirect URIs |
| OneDrive | Hard | MSAL.js has poor extension support; hand-rolled PKCE; personal vs. work/school use different authority URLs |

Recommended build order once this phase starts: Google Drive first, then Dropbox, then OneDrive.

**Constraints that apply once this work starts:**

- **Redirect URIs** aren't stable for extensions — register both `chrome-extension://{ID}/callback` and `moz-extension://`; the ID can change in dev builds.
- **Refresh tokens** can't live in memory (service workers die) — store encrypted in OPFS.
- **CORS** — all cloud API calls must originate from the background service worker, never content scripts (cloud providers block CORS from content scripts).
- **MV3 service worker keepalive** — operations over ~30s get killed mid-sync. Mitigate with `chrome.alarms`, offscreen documents, or chunking sync into <30s pieces.
- **Conflict resolution** — `.kdbx` is a binary blob; no provider resolves simultaneous-write conflicts. This is the extension's responsibility. Implement a merge-or-overwrite flow consistent with KeePassXC (§14).

#### OAuth2 Strategy (for when this phase starts)

Use `chrome.identity.launchWebAuthFlow` (Chrome) / `browser.identity.launchWebAuthFlow` (Firefox) for all OAuth2 flows. Do not open new tabs or popups.

- **Access tokens:** Store AES-256-GCM encrypted in OPFS (not `chrome.storage` — OPFS is more isolated)
- **Refresh tokens:** Same — encrypted at rest in OPFS
- **Auto-refresh:** Intercept 401 responses, refresh token transparently, retry original request
- **Revocation:** Delete OPFS token files + call provider's revoke endpoint

#### Provider-Specific Notes

| Provider | Notes |
|---|---|
| **Google Drive** | Drive REST API v3. Use `drive.file` scope (not `drive.readonly` — need write access). Conflict detection via `If-Match: <etag>` header on writes. File picker: use Google Picker API in the options page. |
| **Dropbox** | API v2. Use `/files/upload` with `mode: "overwrite"`. Conflict detection via `rev` field. Dropbox-API-Arg header pattern for metadata. |
| **OneDrive** | MS Graph API `/me/drive/items/{id}/content`. Standard OAuth2 flow (MSAL optional). ETag from response headers for conflict detection. |

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

```jsonc
// manifests/manifest.chrome.json (MV3)
{
  "manifest_version": 3,
  "background": { "service_worker": "background.js" },
  "permissions": ["storage", "identity", "alarms", "idle", "tabs", "scripting"],
  "host_permissions": ["<all_urls>"]
}

// manifests/manifest.firefox.json (MV2)
{
  "manifest_version": 2,
  "background": { "scripts": ["background.js"], "persistent": true },
  "permissions": ["storage", "identity", "tabs", "<all_urls>"]
}
```

---

## 10. Build System & Testing

### 10.1 Webpack Config

`packages/web/build/webpack.config.js` defines five separate entry points — never combine them:

| Bundle (compiled output) | Entry (TypeScript source) | Runs in |
|---|---|---|
| `background.js` | `src/background/index.ts` | Service worker / background page |
| `content.js` | `src/autofill/content.ts` | Page context (injected) |
| `popup.js` | `src/ui/popup/App.tsx` | Extension popup iframe, post-unlock |
| `manager.js` | `src/ui/manager/App.tsx` | Extension tab (full page), post-unlock only |
| `options.js` | `src/ui/options/App.tsx` | Full options page, reachable pre-unlock |

`@keetar/core` is a normal workspace dependency of `@keetar/web`, not a separate bundle. Build targets: `packages/web/dist/chrome/` and `packages/web/dist/firefox/`. WASM files copy verbatim to `dist/<target>/wasm/argon2/` — do not bundle them. Copied from the `argon2-browser` dependency's own `dist/argon2.{js,wasm}` in `node_modules` at build time, not from a vendored copy in the source tree (§2.4) — see the `webpack.config.js` note there for why.

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
  { entryUrl: 'https://accounts.google.com', tabUrl: 'https://accounts.google.com/login', expectedTier: 1 },
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
| **2** | Local-file backend + vault session (`@keetar/web`) | Open a real local `.kdbx` file via the File System Access API, decrypt, hold in memory, lock on idle timeout. Browser console or minimal UI only — in practice this still needs *some* page: `showOpenFilePicker()` requires an active document with a user gesture, which a service worker doesn't have. `src/dev-harness/` fills that gap (file-picker button + password field + unlock/lock buttons, messaging the background service worker) — it is explicitly not one of §8.1's three real UI surfaces and should be deleted once Popup (Phase 3) and Options exist for real. |
| **3** | Popup UI (read-only) | Show entry list, search, copy username/password to clipboard. No editing, no autofill yet. |
| **4** | Autofill | Content script + domain matching + credential injection. Test manually on 10 real sites including Google and GitHub. |
| **5** | Write path | `kdbx-format.ts`'s `save()`/`saveV4()` (§2.7 — per-object-model split, not a separate `writer.ts`) — add, edit, delete entries, save back to the local file handle. **Critical:** output must open in KeePassXC desktop without errors. |
| **6** | Manager UI | Full vault-content management surface (§8), post-unlock only: entry editing, group management, attachments, wired to the write path from Phase 5. |
| **7** | Biometric unlock | WebAuthn PRF enrolment and unlock, folded into the same gesture as file-handle re-grant (§6.2). Requires real device testing — Touch ID, Windows Hello, and at least one FIDO2 hardware key. |
| **8** | TOTP + health | TOTP generation + autofill, HIBP breach checking, password health report (weak, reused, old, breached). |
| **9** | Import / export | CSV, Bitwarden JSON, 1Password 1PUX, Proton Pass JSON. Export to CSV and XML. |
| **10** | Cloud providers (deferred, §7.3) | Google Drive first (largest user base), then Dropbox, then OneDrive. One provider at a time. Each must handle offline + conflict cases via the OPFS sync strategy (§4.3). |
| **11** | Firefox + polish | MV2 manifest, platform shim verification, Firefox-specific bug fixes. Submit to Chrome Web Store and Firefox AMO. |

---

## 13. Dependencies & Rationale

| Package | Version | Rationale |
|---|---|---|
| `typescript` | `~5.9.0` in `@keetar/core` | Strict typing across both packages — a stated primary goal (§1.1). All source files are `.ts`/`.tsx` (§2.4). Initially pinned to `~5.6.0` to match the minor version keewebx's bootstrapped `crypto/`/`kdbx/` source (§2.7) was actually built and typechecked against, since TS 5.7+ made typed arrays generic over their buffer type (`Uint8Array<ArrayBuffer>` vs. the old bare `Uint8Array`), breaking structural compatibility throughout that code for no behavioral reason. Deliberately upgraded to `5.9.3` (latest of the mature JS-based compiler line — TS jumped straight from 5.9 to a `7.0` native Go rewrite, too fresh/unproven a jump to take alongside this work) and the ~80 resulting error sites fixed directly: pinned `Uint8Array`-returning helpers in `byte-utils.ts` to `Uint8Array<ArrayBuffer>`, widened a few pervasively-used signatures (`CryptoEngine`'s `BufferLike = ArrayBuffer \| Uint8Array<ArrayBuffer>` param type, `VarDictionaryAnyValue`) to match what their runtime code already accepted, and wrapped remaining call sites with the existing `arrayToBuffer()` helper. `CryptoEngine.random()` changed from returning `Uint8Array` to `ArrayBuffer` (its callers overwhelmingly wanted the latter; the few needing indexed byte access now wrap explicitly). Stay current with the 5.9.x line going forward; revisit TS 7 as its own deliberate, separately-verified upgrade once its toolchain ecosystem (vitest, ts-loader) is proven. |
| `argon2-browser` | latest | WASM Argon2id — no in-browser alternative exists. Use WASM build, not JS fallback. Loaded directly against its low-level WASM `Module` rather than through its public `hash()` wrapper in both places it's used, not just one: `@keetar/core`'s test-only Argon2 implementation (§2.7) via Node's `createRequire`, and `@keetar/web`'s real runtime implementation (`background/argon2-wasm.ts`) via `importScripts()` (§3.1, §11.4) — the public wrapper hardcodes Argon2 version 0x13 and only accepts UTF-8 string input, but real KDBX4 files can specify version 0x10 and our composite key/salt are raw bytes. |
| `@stablelib/chacha` | latest | ChaCha20 inner stream for KDBX4 (package name is `@stablelib/chacha`, not `@stablelib/chacha20` — see §3.1). Audited, minimal, TS types. Swapped in for keewebx's own hand-rolled ChaCha20 implementation during the §2.7 bootstrap. |
| `@xmldom/xmldom` | latest | DOM-compliant XML parser for non-DOM environments (service worker, Node tests). See §3.1. |
| `tldts` | latest | TLD-aware domain parsing. ~10KB. Required for correct base-domain matching across all public suffixes. |
| `fflate` | latest | DEFLATE for KDBX payload blocks. ~8KB gzipped. Faster and smaller than pako. |
| `react` + `react-dom` | 18.x | Popup, manager, and options UI only. Not loaded in background or content scripts. |
| `zxcvbn` | latest | Password strength estimation — same library KeePassXC uses. Load lazily in generator UI only. |
| `webpack` + `ts-loader` | latest | Build tooling (`@keetar/web`). `ts-loader` alone compiles TypeScript directly (typechecked, via the real `tsc` program) — no `babel-preset-typescript` needed on top of it. Two separate webpack configs, not one multi-entry config: the service worker bundle (`target: 'webworker'`) and extension-page bundles (`target: 'web'`) need incompatible globals (no `document` in the former, no worker-only APIs assumed in the latter), and webpack's `target` is config-wide, not per-entry. Not bundled into extension output. |
| `copy-webpack-plugin` | latest | Copies `manifests/*.json` → `manifest.json`, `argon2-browser`'s `dist/argon2.{js,wasm}` from `node_modules` → `wasm/argon2/` (§10.1 — WASM files copy verbatim, never bundled, and not vendored in the source tree — §2.4), and extension-page HTML into each build target's output directory. |
| `@types/chrome` | latest | Ambient types for `chrome.*` APIs (storage, idle, alarms, runtime). |
| `@types/wicg-file-system-access` | latest | Ambient types for the File System Access API (`showOpenFilePicker`, `FileSystemFileHandle`, `queryPermission`/`requestPermission`) — not yet part of TypeScript's bundled DOM lib. |
| `vitest` | latest | Unit testing across both packages. Not bundled into extension output. |

> ⚠️ **Rule for adding any new dependency:** audit it for network requests at import time. Any dependency that phones home at load is disqualifying. All network activity in this extension must be explicit and user-initiated.

---

## 14. Open Decisions for Implementation

These are not blocking issues but should be resolved early in the relevant phase. Do not guess — raise them for a decision.

**Password generator default** — Characters or words? KeePassXC defaults to characters. Recommendation: character-based default with a toggle to passphrase mode, configurable per-entry. Decide in Phase 3.

**Auto-save behaviour** — Save edits immediately on change, or require an explicit save action? KeePassXC has both modes. Recommendation: explicit save with a dirty indicator — avoids partial saves during flaky cloud connections (and, near-term, avoids surprising writes to a file another sync client may be touching). Decide in Phase 5 (write path); consumed by the Manager UI in Phase 6.

**Multiple vaults** — MVP supports one vault only. Multi-vault support complicates the session model and UI significantly. Treat as a post-1.0 feature. Do not design Phase 2/3 in a way that makes it impossible to add later — use vault UUID namespacing in OPFS from the start (§4.1).

**Passkey storage (RP mode)** — KeePassXC 2.7.7+ stores passkeys for third-party sites (acting as a WebAuthn relying party). This is a distinct feature from using WebAuthn for biometric unlock (§6). Decide whether to include in v1 before Phase 3 — it affects the entry model and UI.

**Conflict resolution UX** — Merge-or-overwrite dialog design for cloud-backed vaults (§7.3, §4.3). Reference KeePassXC behavior as baseline. Not urgent — no committed phase until cloud OAuth (Phase 10) starts, but the Manager UI (Phase 6) is where this dialog will eventually live, so avoid designing its layout in a way that precludes adding it.
