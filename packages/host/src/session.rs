use crate::vault_file::{etag, modified_ms, write_atomic};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

// Base64 grows data by a third, so this keeps each read reply well under the browser's 1 MB cap.
const READ_CHUNK_BYTES: usize = 512 * 1024;

pub trait Picker {
    fn pick_open(&self) -> Option<PathBuf>;
    fn pick_save(&self, suggested_name: &str) -> Option<PathBuf>;
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Ping,
    PickOpen,
    PickSave { suggested_name: String },
    Stat { path: PathBuf },
    Read { path: PathBuf, offset: usize },
    Write { path: PathBuf, data_base64: String, expected_etag: Option<String> },
    Forget { path: PathBuf },
}

struct Failure {
    code: &'static str,
    message: String,
}

fn failure(code: &'static str, message: impl Into<String>) -> Failure {
    Failure { code, message: message.into() }
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        failure("IO_ERROR", error.to_string())
    }
}

pub struct Session<P: Picker> {
    picker: P,
    approved_file: PathBuf,
    // One snapshot per read, so a file changing between chunks can't produce a torn vault.
    reading: Option<(PathBuf, Vec<u8>)>,
}

impl<P: Picker> Session<P> {
    pub fn new(picker: P, approved_file: PathBuf) -> Self {
        Self { picker, approved_file, reading: None }
    }

    pub fn handle(&mut self, message: &[u8]) -> Vec<u8> {
        let parsed: Value = serde_json::from_slice(message).unwrap_or(Value::Null);
        let id = parsed.get("id").cloned().unwrap_or(Value::Null);
        let result = serde_json::from_value::<Request>(parsed)
            .map_err(|e| failure("BAD_REQUEST", e.to_string()))
            .and_then(|request| self.dispatch(request));
        let reply = match result {
            Ok(mut value) => {
                value["id"] = id;
                value["ok"] = json!(true);
                value
            }
            Err(error) => json!({ "id": id, "ok": false, "code": error.code, "error": error.message }),
        };
        serde_json::to_vec(&reply).unwrap_or_default()
    }

    fn dispatch(&mut self, request: Request) -> Result<Value, Failure> {
        match request {
            Request::Ping => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
            Request::PickOpen => self.approve_picked(self.picker.pick_open()),
            Request::PickSave { suggested_name } => self.approve_picked(self.picker.pick_save(&suggested_name)),
            Request::Stat { path } => self.stat(&path),
            Request::Read { path, offset } => self.read(path, offset),
            Request::Write { path, data_base64, expected_etag } => self.write(&path, &data_base64, expected_etag),
            Request::Forget { path } => self.forget(&path),
        }
    }

    fn approve_picked(&self, picked: Option<PathBuf>) -> Result<Value, Failure> {
        let Some(path) = picked else {
            return Ok(json!({ "path": null }));
        };
        let mut approved = self.load_approved();
        approved.insert(path.clone());
        self.save_approved(&approved)?;
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        Ok(json!({ "path": path, "name": name }))
    }

    fn stat(&self, path: &Path) -> Result<Value, Failure> {
        self.require_approved(path)?;
        let data = read_vault(path)?;
        Ok(json!({ "size": data.len(), "modifiedMs": modified_ms(path)?, "etag": etag(&data) }))
    }

    fn read(&mut self, path: PathBuf, offset: usize) -> Result<Value, Failure> {
        self.require_approved(&path)?;
        if offset == 0 {
            self.reading = Some((path.clone(), read_vault(&path)?));
        }
        let Some((_, data)) = self.reading.as_ref().filter(|(reading, _)| *reading == path) else {
            return Err(failure("BAD_REQUEST", "read must start at offset 0"));
        };
        let start = offset.min(data.len());
        let end = (start + READ_CHUNK_BYTES).min(data.len());
        let reply = json!({
            "dataBase64": STANDARD.encode(&data[start..end]),
            "size": data.len(),
            "etag": etag(data),
            "done": end == data.len(),
        });
        if end == data.len() {
            self.reading = None;
        }
        Ok(reply)
    }

    fn write(&mut self, path: &Path, data_base64: &str, expected_etag: Option<String>) -> Result<Value, Failure> {
        self.require_approved(path)?;
        let data = STANDARD.decode(data_base64).map_err(|e| failure("BAD_REQUEST", e.to_string()))?;
        let current = match fs::read(path) {
            Ok(bytes) => Some(etag(&bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if let Some(expected) = expected_etag {
            if current.as_deref() != Some(expected.as_str()) {
                return Err(failure("CONFLICT", "This database changed on disk since Keetar last read it."));
            }
        }
        write_atomic(path, &data)?;
        Ok(json!({ "size": data.len(), "modifiedMs": modified_ms(path)?, "etag": etag(&data) }))
    }

    fn forget(&mut self, path: &Path) -> Result<Value, Failure> {
        let mut approved = self.load_approved();
        approved.remove(path);
        self.save_approved(&approved)?;
        Ok(json!({}))
    }

    fn require_approved(&self, path: &Path) -> Result<(), Failure> {
        if self.load_approved().contains(path) {
            return Ok(());
        }
        Err(failure("NOT_APPROVED", "Choose this database again in Keetar's Options page."))
    }

    // Read every time: the background page and Options each run their own host process.
    fn load_approved(&self) -> BTreeSet<PathBuf> {
        fs::read(&self.approved_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save_approved(&self, approved: &BTreeSet<PathBuf>) -> Result<(), Failure> {
        if let Some(parent) = self.approved_file.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(approved).map_err(|e| failure("IO_ERROR", e.to_string()))?;
        write_atomic(&self.approved_file, &bytes)?;
        Ok(())
    }
}

fn read_vault(path: &Path) -> Result<Vec<u8>, Failure> {
    fs::read(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => failure("NOT_FOUND", "This database file could not be found."),
        _ => e.into(),
    })
}
