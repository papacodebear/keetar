# Keetar helper

A small companion program that lets Keetar open and save local KeePass databases in Firefox, which doesn't give extensions direct access to your files. Chrome doesn't need it, and neither do vaults stored in Google Drive.

## Install

Download the file for your system from Keetar's **Local files** section in Options, or from the [releases page](https://github.com/papacodebear/keetar/releases), move it somewhere permanent, and run it once. Each release includes a `SHA256SUMS` file for checking your download.

- **Linux:** run `chmod +x` on the file first.
- **macOS (Apple Silicon):** the helper isn't signed yet, so run `xattr -d com.apple.quarantine` on the file, then `chmod +x`, then run it in Terminal.
- **Windows:** the helper isn't signed yet, so choose **More info → Run anyway** when SmartScreen warns you.

To build it yourself instead, with [Rust](https://rustup.rs/) installed:

```sh
cargo build --release
./target/release/keetar-host
```

Running it with no arguments registers it with Firefox for your user account, using its current location. If you move it, run it again. Keetar's Options page shows the helper's status under **Local files**, and updates once it's installed.

To remove it, run `keetar-host uninstall` and delete the program.

Firefox installed as a Snap or Flatpak isn't supported yet, because sandboxed browsers can't start the helper directly.

## What it can access

- It only reads and writes files you chose in your system's file dialog. That list is kept in your user config folder as `keetar-host/approved-files.json`.
- Only the Keetar extension (`keetar@keetar.app`) is allowed to start it.
- It makes no network connections, and only ever handles your vault file in its encrypted form.
- It saves to a temporary file and then renames it, so a crash can't leave a half-written vault.
- It won't overwrite a database that changed since Keetar read it, such as an edit from KeePassXC.

## Development

```sh
cargo test
```

To publish a release, update the version in `Cargo.toml` and `HOST_VERSION` in `packages/web/src/providers/native-file.ts`, then push a `host-v<version>` tag.

Messages use Firefox's native messaging format: JSON preceded by a 32-bit length. Replies are limited to 1 MB, so files are read in chunks.
