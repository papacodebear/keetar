# Store listing

Copy for the Chrome Web Store and Firefox Add-ons submissions.

## Shared

- **Name:** Keetar
- **Summary (132 characters max):** Open-source KeePass in your browser. Read and write real .kdbx vaults and autofill logins, with no desktop app or account.
- **Category:** Chrome: Tools. Firefox: Privacy & Security.
- **Homepage:** https://keetar.com
- **Support:** https://github.com/papacodebear/keetar/issues
- **Privacy policy:** https://keetar.com/privacy.html
- **Licence:** GPL-3.0

### Description

Keetar brings your KeePass vault into your browser. It reads and writes real KDBX4 files, so your vault keeps working with KeePassXC and other KeePass apps. There's no desktop app to install, no account to create and no Keetar server.

Features:

- Open a vault from your computer, where your browser allows it, or from your own Google Drive
- Autofill logins, including multi-step sign-ins, on sites you've trusted
- Generate passwords and passphrases, and update saved logins when you change them
- Generate and fill one-time codes
- Create and sign in with passkeys on websites (optional)
- Find weak, reused, old and breached passwords
- Unlock with a FIDO2 security key or your device's biometric unlock
- Import from CSV, Bitwarden, 1Password and Proton Pass, or combine two vaults

Your vault stays encrypted with the same format KeePassXC uses, and your master password never leaves your device. Keetar has no analytics or tracking.

Open source: https://github.com/papacodebear/keetar

Biometric and security key unlock on Firefox requires version 150 or later.

## Chrome Web Store privacy tab

**Single purpose:** Keetar is a password manager that opens KeePass databases in the browser and fills saved logins into websites.

**Remote code:** No. All code is included in the extension package.

| Permission | Justification |
|---|---|
| `storage` | Saves settings, such as which vault is configured, locally. |
| `idle` | Locks the vault after the user's chosen idle time or when the device locks. |
| `alarms` | Schedules clipboard clearing and vault lock checks. |
| `clipboardWrite` | Copies a username, password or one-time code when the user asks. |
| `clipboardRead` | Checks that the clipboard still holds the copied secret before clearing it, so other content isn't erased. |
| `offscreen` | Runs clipboard clearing, which needs a document, after the popup closes. |
| `tabs` | Reads the active tab's URL to match saved logins, and sends fill requests to that tab. |
| `identity` | Signs in to Google so the user can store their vault in their own Google Drive. |
| Host access (`http://*/*`, `https://*/*`) | Detects and fills login forms and offers passkeys on sites the user visits, and fetches favicons when requested. |
