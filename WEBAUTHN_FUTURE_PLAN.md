# Keetar as a WebAuthn passkey provider

## Context

The motivation: keep passkeys in the same portable, self-owned KDBX file as everything else, rather than locked into Google/Apple's platform silo. There's no way to *extract* an existing platform passkey (private keys are non-exportable by design), so this is scoped to **new passkeys going forward**: Keetar generates and holds the keypair itself from the moment a site's "create a passkey" flow runs. Trade-off worth stating up front: this makes the passkey only as safe as the vault (same protection class as a password), not hardware-non-extractable the way a platform passkey is — that's the cost of the portability being sought.

Mechanism: 1Password/Bitwarden/Dashlane do this today by monkey-patching `navigator.credentials.create()`/`.get()` in the page's own JS context — there's no official extension API for registering as a selectable option in the browser's native WebAuthn picker (`chrome.webAuthenticationProxy` is gated to remote-desktop use and monopolizes all WebAuthn traffic rather than coexisting as a picker option). Real, if fragile — the W3C WebAuthn WG has an open issue acknowledging extensions are "forced to monkey-patch" (w3c/webauthn#1976).

## Scope

Registration (`create()`) and assertion (`get()`) against a known `allowCredentials` list, ES256 (P-256) only, attestation format `"none"`. Out of scope: discoverable/resident-credential "usernameless" sign-in, cross-device/hybrid transport. Interception is off by default, a Settings toggle turns it on.

## Architecture: the relay chain (in-page interception)

A page's own JS can't reach `chrome.runtime` APIs, and the isolated-world content script can't reach the page's `navigator.credentials`. Both hops, plus a UI surface for confirm/picker/unlock, are needed:

1. **MAIN-world shim** (new content script, `"world": "MAIN"`) — monkey-patches `navigator.credentials.create`/`.get()`. Captures the real arguments and the true `window.location.origin`, relays via `postMessage` to the isolated world. No crypto here — only captures inputs and later resolves/rejects the original promise.
2. **Isolated-world content script** (extends `autofill/content.ts`, or a sibling `passkey-provider/` module) — listens for the `postMessage` (validating `event.source === window`), forwards to background via the existing `KeetarRequest`/`KeetarResponse` union in `message-bus.ts`, gets a `requestId`, injects an extension-hosted `<iframe>` overlay pointing at `passkey-prompt.html?requestId=...`.
3. **`passkey-prompt` UI** (new HTML entry point, mirrors `popup`/`options`/`manager`) — React page with full extension privileges. Shows "Create/Use a passkey with Keetar for `rpId`?", handles inline unlock (`UNLOCK_VAULT`), shows an entry picker for `get()` when multiple stored passkeys match, sends `CREATE_PASSKEY`/`SIGN_PASSKEY_ASSERTION` on confirm.
4. **Background** (`vault-session.ts`) does all crypto and vault writes. Generates the ES256 keypair via WebCrypto, builds `authenticatorData` and the CBOR `attestationObject`, stores the passkey (see Storage model), returns only public bytes back through the chain.

Manifest changes: a `"world": "MAIN"` content script entry (reusing existing host permissions), and `web_accessible_resources` for `passkey-prompt.html` (Chrome's manifest needs the key added; Firefox already has it for `picker-callback.html`).

## Storage model

**Passkeys attach to the same KDBX entry as the corresponding login — not a separate entry.** A parallel "site.com (passkey)" entry was the original design; rejected as bad UX (two rows for what's conceptually one account). Since a site can have multiple passkeys and KDBX `<String>` fields are single-valued per key, passkey data lives in **KDBX binary attachments** (`entry.binaries`) instead of indexed custom fields (`KP_Passkey_1_...`) — attachments natively support many-per-entry, avoiding a naming convention every field-generic consumer would need to special-case.

Trade-off: other KeePass clients will show these as opaque files in the entry's Attachments tab. Acceptable — cross-client editing isn't a goal, only non-corruption.

**Per-passkey attachment**: named `${credentialIdBase64Url}.keetar-passkey.cbor`. Contents: a small CBOR map (`{v, cid, pk, uh, alg, rp, sc}` — schema version, credentialId, PKCS8 private key, userHandle, COSE alg, rpId, sign counter), written via `ProtectedValue.fromBinary()` so it gets the same memory-protection-at-rest as the Password field (KDBX4's binary pool supports a per-binary `Protected` flag independent of the per-entry XML reference). `passkey-provider/cbor.ts` needs a decoder alongside the encoder already planned for `attestationObject` — a second, unrelated CBOR document, not required to be spec-compliant with anything external.

**Lookup index**: attachments aren't part of today's searchable-field surface, so decrypting every attachment on every entry to answer "does this entry have a passkey for `rpId`" would be expensive. Each entry with at least one passkey gets one extra plain (unprotected) custom field, `KP_Passkey_Index`, holding a small JSON array of `{credentialId, rpId}`. Listing walks entries the normal way and parses this one cheap field; only the specific attachment for the credential the user picks gets decoded. WebAuthn's rpId matching is exact-string — stricter than the fuzzy hostname matching `autofill/matcher.ts` uses for passwords.

**Entry-matching on `create()`**: convert `rpId` to a pseudo-URL and run it through the existing `matchEntries()` matcher.
- One match → attach to that entry.
- Multiple matches → passkey-prompt UI shows the match list plus "Create new entry."
- No match → create a new entry (same path as `CREATE_ENTRY`): title = `user.displayName` or bare `rpId`, username = `user.name`, url = `https://${rpId}`, no "(passkey)" suffix — it should look like an ordinary login entry.

**On `get()`**: `LIST_PASSKEYS_FOR_RPID` scans the index field, filters by `allowCredentials` if supplied.

**Sign-counter updates**: read the one attachment, CBOR-decode, sign, increment `sc`, re-encode, write back under the same attachment key — only that attachment is touched.

**Bug found in passing, needs fixing regardless of passkeys**: `KdbxBinaries` is content-addressed by hash and nothing removes a binary's *previous* hash from the pool except `Kdbx.cleanup({ binaries: true })`, which today is only called from `merge()`, never from `VaultSession.persist()`. Every attachment update (sign-counter bumps included) would leave the old blob permanently embedded in the file, growing unboundedly. Fix: call `db.cleanup({ binaries: true, customIcons: true })` in `persist()` before `save()`. General correctness fix, not passkey-specific — also affects today's `removeAttachment()`.

**New files**: `background/passkey-store.ts` (pure entry-matching/index/attachment-naming logic, called from `vault-session.ts`, mirrors the `background/dedup.ts` convention), decoder added to `passkey-provider/cbor.ts`, new `vault-session.ts` methods (`createPasskey`, `signPasskeyAssertion`, `listPasskeysForRpId`), new `message-bus.ts` variants (`LIST_PASSKEYS_FOR_RPID`, `CREATE_PASSKEY`, `SIGN_PASSKEY_ASSERTION`) plus `background/index.ts` dispatch cases.

**Security**: `SIGN_PASSKEY_ASSERTION` must re-validate `rpId` against `origin` itself, not trust the caller already did it. `KP_Passkey_Index` must be a reserved field name (see Custom fields) so it can't be renamed/overwritten from the UI. Deleting a passkey must remove the attachment and its index entry atomically in one `persist()` — flagged for the delete-flow design, not resolved here.

## Custom fields

General-purpose feature, ships alongside the above: a "Custom Fields" section in the entry-editing UI letting a user add arbitrary named fields, each independently toggleable Protected (KDBX4 inner-stream encryption, same `ProtectedValue` mechanism as Password) or plain. Motivating example: a GitHub API token as a hidden field on the GitHub entry.

Mostly a UI feature — `KdbxEntry.fields` is already `Map<string, string | ProtectedValue>` with protection decided purely by value type, no fixed-name allowlist. KeePass/KeePassXC's own UI already exposes this same per-field protected checkbox on the same XML node — Keetar is catching up to something the format already fully supports.

**Reserved field names**: `Title/UserName/Password/URL/Notes` (dedicated inputs), `otp`/TOTP Seed, `KP2A_URL_\d+` (extra autofill URLs), and `KP_Passkey_Index` (new) must never be user-editable as generic custom fields. Centralize in one `isReservedFieldName()` helper (new `background/reserved-fields.ts`), shared by the custom-fields read/write path and `passkey-store.ts`.

**Read path**: extend `EntryDetail` with an `EntryCustomField[]` (`name`, `value`, `protected`) populated by iterating `entry.fields`, skipping reserved names, resolving values the same way the existing `password` field already does.

**Write path**: doesn't fit the existing closed-set `EntryFields`/`UPDATE_ENTRY` shape, so gets its own message types: `SET_CUSTOM_FIELD` (create-or-update by name, also how the Protected toggle is flipped), `RENAME_CUSTOM_FIELD`, `REMOVE_CUSTOM_FIELD`. All three follow the existing `updateEntry()` pattern (`pushHistory()` → mutate → `times.update()` → `persist()`), with validation (reject reserved names, empty names, case-sensitive name collisions) enforced in the handler, not just the UI.

**UI**: new `ui/manager/CustomFieldsSection.tsx` (first split-out sub-component from the increasingly large `App.tsx`), rendered between Attachments and Delete. Each row: name input (rename on blur), value input that toggles `text`/`password` type per-field (independent reveal state per row, unlike the single Password field's one toggle), a Protected checkbox, a Remove button — mirrors the existing Attachments row's add/remove affordances.

**Verification**: unit tests for add/rename/remove round-trip and reserved-name rejection; manually confirm a Protected custom field created in Keetar opens correctly (value present, masked, protected flag honored) in KeePassXC — unlike passkey attachments, custom fields are meant to be fully cross-client compatible.

## Native OS-level integration (out of scope)

Considered and explicitly descoped: registering Keetar as a system-wide credential provider (`ASCredentialProviderExtension` on macOS, `IPluginAuthenticator` on Windows) so it shows up in the OS's native "choose a passkey" picker outside the browser, or shipping a standalone desktop app (Electron or otherwise) acting as a local password-manager backend. Rejected for this effort:

- It requires two separate native codebases (Swift + Windows COM/MSIX) with their own signing, notarization, and packaging burden — a materially different, much larger project than the in-browser work above.
- Real-world browser delegation to the OS credential-provider framework is currently inconsistent even where the framework exists — e.g. Chrome on macOS has open bugs where its own native dialog wins over a correctly-registered third-party provider ([bitwarden/clients#20743](https://github.com/bitwarden/clients/issues/20743)) — so it wouldn't reliably improve in-browser coverage anyway.
- Its actual unique value — reaching genuinely native, non-browser apps — is narrow today, since most passkey-capable software is still browser- or webview-based, which the monkey-patch approach already covers wherever Keetar's extension is installed.

The monkey-patch interception above is independent of this and fully covers passkey creation and sign-in in any browser Keetar's extension is installed in, pointed at the same vault — including across multiple browsers, since they'd all read/write the same KDBX file. If OS-wide reach is revisited later, treat it as a separate, deliberately-scoped project, not an extension of the work above.

## Verification (whole feature)

- Unit tests: `cbor.ts` round-trip (both the `attestationObject` and passkey-attachment schemas), `webauthn-crypto.ts` (authenticatorData byte layout, signature verifies via WebCrypto), `passkey-store.ts` (entry-matching, index maintenance), custom-fields add/rename/remove/reserved-name rejection.
- Manual end-to-end: real site with passkey support (GitHub, or a local WebAuthn demo) in both Chrome and Firefox — create a passkey, confirm it attaches to the matching entry (or creates one) with the expected attachment + index field, lock/reopen, sign in, confirm the sign counter increments and no stale attachment blobs accumulate in the file.
- `pnpm exec tsc --noEmit`, `pnpm run test`, `pnpm run build` (both platforms), `pnpm run lint:firefox`.
