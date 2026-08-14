<p align="center">
  <img src="keytar-svgrepo-com.svg" alt="" width="96" height="96">
</p>

<h1 align="center">Keetar</h1>

<p align="center">
  A TypeScript-native KeePass-compatible browser extension.<br>
  No desktop app required.
</p>

---

Keetar reads and writes real KeePass (KDBX4) vaults directly in the browser — no companion desktop app, no background process, no separate account. Point it at a `.kdbx` file (local, or synced via Google Drive) and it does the rest: unlock, autofill, generate passwords, check for breaches, and edit entries, all client-side.

## Features

- **Full KDBX4 read/write** — vaults stay fully compatible with KeePassXC and other KeePass-family clients
- **Local-first** — open a vault straight from disk via the File System Access API, or connect Google Drive; your vault never touches a Keetar server, because there isn't one
- **Autofill** — detects login forms (including multi-step flows) and offers to fill saved credentials
- **Password generator** — character or passphrase (EFF wordlist) modes, with configurable defaults
- **Password-change detection** — recognizes when a Keetar-generated password was used to change a saved login, and offers to update the entry
- **Password health** — weak/reused/old/breached checks, the last via [Have I Been Pwned](https://haveibeenpwned.com/)'s k-anonymity API (only a hash prefix ever leaves your device — see [PRIVACY.md](PRIVACY.md))
- **TOTP** — generate and autofill one-time codes for entries with a stored secret
- **Biometric unlock** — Touch ID, Windows Hello, and FIDO2 hardware keys via WebAuthn PRF
- **Import / export** — CSV, Bitwarden, 1Password, and Proton Pass formats, plus combining a second vault into your current one
- **Chrome and Firefox**, from a single codebase

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it's built, and [PRIVACY.md](PRIVACY.md) for exactly what data goes where.

## Project layout

A pnpm monorepo with two packages:

| Package | What it is |
|---|---|
| [`@keetar/core`](packages/core) | An isomorphic, browser-API-free TypeScript library: KDBX4 parsing/writing, crypto, password/passphrase generation, TOTP, password health, and import/export. Runs and tests in plain Node. |
| [`@keetar/web`](packages/web) | The browser extension itself — background service worker, popup, manager UI, options page, and content scripts — built on `@keetar/core`. |

## Developing

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm run build       # builds both packages; @keetar/web outputs dist/chrome and dist/firefox
pnpm run test        # runs both packages' test suites
pnpm run typecheck
```

To load the extension for local testing:

- **Chrome**: `chrome://extensions` → enable Developer Mode → Load unpacked → select `packages/web/dist/chrome`
- **Firefox**: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select any file inside `packages/web/dist/firefox`

`pnpm --filter @keetar/web run build:dev` (and `build:firefox:dev`) produce unminified development builds with source maps, if you're debugging.

## License

[GPL-3.0](LICENSE)
