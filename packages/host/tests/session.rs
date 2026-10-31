use base64::{engine::general_purpose::STANDARD, Engine};
use keetar_host::session::{Picker, Session};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

struct FakePicker(PathBuf);

impl Picker for FakePicker {
    fn pick_open(&self) -> Option<PathBuf> {
        Some(self.0.clone())
    }
    fn pick_save(&self, _suggested_name: &str) -> Option<PathBuf> {
        Some(self.0.clone())
    }
}

struct Cancelled;

impl Picker for Cancelled {
    fn pick_open(&self) -> Option<PathBuf> {
        None
    }
    fn pick_save(&self, _suggested_name: &str) -> Option<PathBuf> {
        None
    }
}

fn call(session: &mut Session<impl Picker>, request: Value) -> Value {
    serde_json::from_slice(&session.handle(request.to_string().as_bytes())).unwrap()
}

fn setup(contents: &[u8]) -> (TempDir, PathBuf, Session<FakePicker>) {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault.kdbx");
    fs::write(&vault, contents).unwrap();
    let session = Session::new(FakePicker(vault.clone()), dir.path().join("config/approved.json"));
    (dir, vault, session)
}

fn pick(session: &mut Session<FakePicker>) {
    assert_eq!(call(session, json!({ "id": 1, "op": "pick_open" }))["ok"], true);
}

fn read_all(session: &mut Session<FakePicker>, path: &Path) -> (Vec<u8>, usize, String) {
    let (mut data, mut chunks) = (Vec::new(), 0);
    loop {
        let reply = call(session, json!({ "id": 2, "op": "read", "path": path, "offset": data.len() }));
        assert_eq!(reply["ok"], true, "{reply}");
        data.extend(STANDARD.decode(reply["dataBase64"].as_str().unwrap()).unwrap());
        chunks += 1;
        if reply["done"] == true {
            return (data, chunks, reply["etag"].as_str().unwrap().to_string());
        }
    }
}

#[test]
fn echoes_request_ids_and_reports_a_version() {
    let (_dir, _vault, mut session) = setup(b"x");
    let reply = call(&mut session, json!({ "id": 7, "op": "ping" }));
    assert_eq!(reply["id"], 7);
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn refuses_every_file_operation_on_a_path_the_user_did_not_pick() {
    let (dir, vault, mut session) = setup(b"secret");
    let other = dir.path().join("other.txt");
    fs::write(&other, b"private").unwrap();
    pick(&mut session);
    for request in [
        json!({ "id": 1, "op": "read", "path": other, "offset": 0 }),
        json!({ "id": 1, "op": "stat", "path": other }),
        json!({ "id": 1, "op": "write", "path": other, "data_base64": "eA==" }),
    ] {
        assert_eq!(call(&mut session, request)["code"], "NOT_APPROVED");
    }
    assert_eq!(fs::read(&other).unwrap(), b"private");
    assert_eq!(fs::read(&vault).unwrap(), b"secret");
}

#[test]
fn path_tricks_do_not_escape_the_approved_list() {
    let (dir, vault, mut session) = setup(b"secret");
    fs::write(dir.path().join("other.txt"), b"private").unwrap();
    pick(&mut session);
    let sneaky = format!("{}/../{}/other.txt", vault.display(), dir.path().file_name().unwrap().to_string_lossy());
    assert_eq!(call(&mut session, json!({ "id": 1, "op": "read", "path": sneaky, "offset": 0 }))["code"], "NOT_APPROVED");
}

#[test]
fn large_files_arrive_intact_with_every_reply_under_the_browser_limit() {
    let contents: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    let (_dir, vault, mut session) = setup(&contents);
    pick(&mut session);
    let (mut offset, mut data) = (0usize, Vec::new());
    loop {
        let request = json!({ "id": 2, "op": "read", "path": vault, "offset": offset });
        let raw = session.handle(request.to_string().as_bytes());
        assert!(raw.len() <= keetar_host::framing::MAX_OUTGOING_BYTES);
        let reply: Value = serde_json::from_slice(&raw).unwrap();
        data.extend(STANDARD.decode(reply["dataBase64"].as_str().unwrap()).unwrap());
        offset = data.len();
        if reply["done"] == true {
            break;
        }
    }
    assert_eq!(data, contents);
}

#[test]
fn reads_stay_consistent_if_the_file_changes_between_chunks() {
    let contents = vec![1u8; 1_000_000];
    let (_dir, vault, mut session) = setup(&contents);
    pick(&mut session);
    let first = call(&mut session, json!({ "id": 2, "op": "read", "path": vault, "offset": 0 }));
    let offset = STANDARD.decode(first["dataBase64"].as_str().unwrap()).unwrap().len();
    fs::write(&vault, vec![2u8; 1_000_000]).unwrap();
    let second = call(&mut session, json!({ "id": 3, "op": "read", "path": vault, "offset": offset }));
    assert!(STANDARD.decode(second["dataBase64"].as_str().unwrap()).unwrap().iter().all(|b| *b == 1));
}

#[test]
fn empty_files_read_as_done() {
    let (_dir, vault, mut session) = setup(b"");
    pick(&mut session);
    let (data, chunks, _) = read_all(&mut session, &vault);
    assert!(data.is_empty());
    assert_eq!(chunks, 1);
}

#[test]
fn writes_succeed_when_the_file_is_unchanged() {
    let (_dir, vault, mut session) = setup(b"old");
    pick(&mut session);
    let (_, _, etag) = read_all(&mut session, &vault);
    let request = json!({ "id": 3, "op": "write", "path": vault, "data_base64": STANDARD.encode("new"), "expected_etag": etag });
    let reply = call(&mut session, request);
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(fs::read(&vault).unwrap(), b"new");
    assert_ne!(reply["etag"], Value::String(etag));
}

#[test]
fn refuses_to_overwrite_changes_made_by_another_app() {
    let (_dir, vault, mut session) = setup(b"old");
    pick(&mut session);
    let (_, _, etag) = read_all(&mut session, &vault);
    fs::write(&vault, b"changed by KeePassXC").unwrap();
    let request = json!({ "id": 3, "op": "write", "path": vault, "data_base64": STANDARD.encode("new"), "expected_etag": etag });
    assert_eq!(call(&mut session, request)["code"], "CONFLICT");
    assert_eq!(fs::read(&vault).unwrap(), b"changed by KeePassXC");
}

#[test]
fn approval_survives_a_new_session_and_forget_removes_it() {
    let (dir, vault, mut session) = setup(b"x");
    pick(&mut session);
    let approved = dir.path().join("config/approved.json");
    let mut second = Session::new(Cancelled, approved);
    assert_eq!(call(&mut second, json!({ "id": 1, "op": "stat", "path": vault }))["ok"], true);
    assert_eq!(call(&mut second, json!({ "id": 2, "op": "forget", "path": vault }))["ok"], true);
    assert_eq!(call(&mut second, json!({ "id": 3, "op": "stat", "path": vault }))["code"], "NOT_APPROVED");
}

#[test]
fn cancelling_the_dialog_approves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = Session::new(Cancelled, dir.path().join("approved.json"));
    let reply = call(&mut session, json!({ "id": 1, "op": "pick_open" }));
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["path"], Value::Null);
    assert!(!dir.path().join("approved.json").exists());
}

#[test]
fn missing_files_and_malformed_requests_fail_cleanly() {
    let (_dir, vault, mut session) = setup(b"x");
    pick(&mut session);
    fs::remove_file(&vault).unwrap();
    assert_eq!(call(&mut session, json!({ "id": 1, "op": "stat", "path": vault }))["code"], "NOT_FOUND");
    let reply: Value = serde_json::from_slice(&session.handle(b"not json")).unwrap();
    assert_eq!(reply["code"], "BAD_REQUEST");
}
