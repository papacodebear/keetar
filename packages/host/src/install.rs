use serde_json::json;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const HOST_NAME: &str = "com.keetar.host";
const EXTENSION_ID: &str = "keetar@keetar.app";

pub fn host_manifest(executable: &Path) -> serde_json::Value {
    json!({
        "name": HOST_NAME,
        "description": "Lets Keetar open and save local KeePass files",
        "path": executable,
        "type": "stdio",
        "allowed_extensions": [EXTENSION_ID],
    })
}

fn home() -> io::Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))
}

#[cfg(target_os = "linux")]
fn manifest_path() -> io::Result<PathBuf> {
    Ok(home()?.join(".mozilla/native-messaging-hosts").join(format!("{HOST_NAME}.json")))
}

#[cfg(target_os = "macos")]
fn manifest_path() -> io::Result<PathBuf> {
    Ok(home()?
        .join("Library/Application Support/Mozilla/NativeMessagingHosts")
        .join(format!("{HOST_NAME}.json")))
}

#[cfg(windows)]
fn manifest_path() -> io::Result<PathBuf> {
    Ok(home()?.join("AppData/Local/Keetar").join(format!("{HOST_NAME}.json")))
}

#[cfg(windows)]
fn registry_key() -> String {
    format!(r"HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\{HOST_NAME}")
}

#[cfg(windows)]
fn run_reg(args: &[&str]) -> io::Result<()> {
    let status = std::process::Command::new("reg").args(args).status()?;
    if status.success() {
        return Ok(());
    }
    Err(io::Error::other("reg.exe failed"))
}

pub fn install() -> io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let path = manifest_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_vec_pretty(&host_manifest(&executable))?)?;
    #[cfg(windows)]
    run_reg(&["add", &registry_key(), "/ve", "/t", "REG_SZ", "/d", &path.to_string_lossy(), "/f"])?;
    Ok(path)
}

pub fn uninstall() -> io::Result<()> {
    #[cfg(windows)]
    run_reg(&["delete", &registry_key(), "/f"])?;
    match fs::remove_file(manifest_path()?) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}
