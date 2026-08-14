# Keetar Privacy Policy

_Last updated: 2026-08-13_

Keetar is a browser extension that reads and writes KeePass-compatible (KDBX4) password databases. There is no Keetar server, no Keetar account, and no telemetry. This document describes, precisely, what data the extension touches and where it goes.

## Summary

- Your vault (titles, usernames, passwords, URLs, notes, attachments) is encrypted on your device and never sent to Keetar, because Keetar has no server to send it to.
- The extension makes a small number of network requests, described below, each triggered by a specific action you take — never automatically or in the background without cause.
- Nothing is sold, shared with advertisers, or used for tracking of any kind.

## What Keetar stores, and where

- **Your vault file** lives wherever you put it: a local file on your device (via the File System Access API) or, if you choose to connect it, a file in your own Google Drive. Keetar never has a copy anywhere else.
- **Vault contents** are encrypted with the same KDBX4 format and cryptography KeePassXC uses (Argon2id/AES-256/ChaCha20). The master password/key you use to unlock it is never transmitted anywhere and never leaves your device.
- **Extension settings** (which vault is configured, generator preferences, idle-timeout settings) are stored locally in the browser's own extension storage (`chrome.storage`), never synced to any Keetar-operated service.
- **Biometric unlock** (Touch ID, Windows Hello, FIDO2 keys) uses the WebAuthn PRF extension. The cryptographic material involved is device-bound and never leaves your device.

## Network requests the extension makes

Keetar only makes network requests your own actions trigger — to Keetar's own infrastructure in one specific case (the Drive file picker, below), and to third parties otherwise:

| What | Sent to | What's sent | When |
|---|---|---|---|
| Breach checking | `api.pwnedpasswords.com` (Have I Been Pwned) | A 5-character prefix of a password's SHA-1 hash — never the password or the full hash (the standard "k-anonymity" model HIBP is designed around) | Only when you run a password health check |
| Favicon lookup | The website an entry's URL points to (e.g. `example.com/favicon.ico`) | A normal, anonymous favicon request — the same kind your browser already makes when you visit that site | Only when you fetch favicons for an entry, or ask to fetch them in bulk |
| Cloud sync | Google's own APIs (Drive, OAuth) | Your vault file's bytes (still encrypted) on every read/write. The extension itself holds a Google OAuth token to do this — obtained through the standard OAuth flow and stored encrypted at rest, locally, never on any Keetar server | Only if you choose Google Drive as a storage backend, never for the local-file backend |
| Google Drive file picker | [`google-picker-bridge.papacodebear.workers.dev`](https://google-picker-bridge.papacodebear.workers.dev/) — a static page Keetar operates (Cloudflare-hosted), which loads Google's own Picker widget. Source here: [github.com/papacodebear/google-picker-bridge](https://github.com/papacodebear/google-picker-bridge) | That page obtains its own, separate Google OAuth token — distinct from the extension's sync token above — used only to power the picker's file-browsing UI. Only the file ID and name of whatever you pick is returned to the extension; that token stays on the page and is never sent to Keetar or stored anywhere | Only when you use the Drive picker to choose a vault file |

Note on **"Organize with your own AI"**: this feature does not call any AI service itself. It generates a plain-text export (titles, URLs, and current folder — never usernames or passwords) that you manually copy and paste into a chat with whatever AI assistant you already use, and you manually paste its reply back in. Keetar never transmits anything to an AI provider on your behalf.

## What Keetar never does

- Never sends your master password, vault passwords, or decrypted vault contents anywhere.
- Never includes analytics, crash reporting, or usage tracking.
- Never shares data with advertisers or data brokers — there's nothing to share, and no server to share it from.

## Permissions

Keetar requests browser permissions (`storage`, `tabs`, `clipboardWrite`, host access, etc.) only to do the things described in this document: reading the page you're on to detect and fill login forms, copying a password to your clipboard when you ask, and storing your configuration locally.

## Changes to this policy

If what the extension does changes in a way that affects this document, this file will be updated and the "Last updated" date above will change accordingly.

## Contact

Questions about this policy can be raised as an issue on this repository.
