use keetar_host::framing::{read_message, write_message};
use keetar_host::install::{install, uninstall};
use keetar_host::session::{Picker, Session};
use std::io;
use std::path::PathBuf;

struct SystemPicker;

impl Picker for SystemPicker {
    fn pick_open(&self) -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_title("Open KeePass database")
            .add_filter("KeePass database", &["kdbx"])
            .pick_file()
    }

    fn pick_save(&self, suggested_name: &str) -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_title("Save KeePass database")
            .add_filter("KeePass database", &["kdbx"])
            .set_file_name(suggested_name)
            .save_file()
    }
}

fn serve() -> io::Result<()> {
    let config = dirs::config_dir().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no config directory"))?;
    let mut session = Session::new(SystemPicker, config.join("keetar-host/approved-files.json"));
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Some(message) = read_message(&mut input)? {
        write_message(&mut output, &session.handle(&message))?;
    }
    Ok(())
}

fn main() -> io::Result<()> {
    // Firefox always passes the manifest path, so running with no arguments means a person started it.
    match std::env::args().nth(1).as_deref() {
        None | Some("install") => {
            println!("Keetar helper registered with Firefox: {}", install()?.display());
            Ok(())
        }
        Some("uninstall") => {
            uninstall()?;
            println!("Removed the Firefox registration.");
            Ok(())
        }
        _ => serve(),
    }
}
