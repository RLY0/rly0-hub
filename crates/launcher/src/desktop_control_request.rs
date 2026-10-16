//! RLY/0 Hub: lets the Host ask its own Launcher to force-quit or restart the managed Desktop.
//!
//! The Host runs inside the Desktop process tree, so it cannot outlive a Desktop it stops. Instead
//! it writes one small request file next to the runtime descriptor; the Launcher, which supervises
//! the Desktop from outside, picks it up on its lifecycle tick. A request only counts when it
//! names this Launcher's PID and carries the per-launch control nonce that the Launcher handed to
//! the Desktop environment, so stale or foreign files are ignored and removed.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub(crate) const DESKTOP_CONTROL_REQUEST_FILE: &str = "desktop-control-request.json";
const MAX_REQUEST_BYTES: u64 = 4 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DesktopControlAction {
    Quit,
    Restart,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestFile {
    schema_version: u32,
    launcher_pid: u32,
    nonce: String,
    action: String,
}

pub(crate) fn request_path(descriptor_path: &Path) -> PathBuf {
    descriptor_path.with_file_name(DESKTOP_CONTROL_REQUEST_FILE)
}

/// Returns the pending action for this Launcher, removing the file once it has been read.
/// Malformed requests and requests for another Launcher instance are removed and ignored.
pub(crate) fn take_request(
    path: &Path,
    launcher_pid: u32,
    nonce: &str,
) -> io::Result<Option<DesktopControlAction>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.len() > MAX_REQUEST_BYTES {
        // Never follow or read anything unexpected; just drop it.
        let _ = fs::remove_file(path);
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    let parsed = serde_json::from_slice::<RequestFile>(&bytes).ok();
    let action = parsed.and_then(|request| {
        if request.schema_version != 1
            || request.launcher_pid != launcher_pid
            || nonce.is_empty()
            || request.nonce != nonce
        {
            return None;
        }
        match request.action.as_str() {
            "quit" => Some(DesktopControlAction::Quit),
            "restart" => Some(DesktopControlAction::Restart),
            _ => None,
        }
    });
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok(action)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "codexhost-desktop-control-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("fixture directory");
        request_path(&directory.join("runtime.json"))
    }

    fn write(path: &Path, body: &str) {
        fs::write(path, body).expect("write request");
    }

    #[test]
    fn missing_request_is_none() {
        let path = fixture("missing");
        assert_eq!(take_request(&path, 7, "nonce").unwrap(), None);
    }

    #[test]
    fn accepts_a_matching_request_once() {
        let path = fixture("accept");
        write(
            &path,
            r#"{"schemaVersion":1,"launcherPid":7,"nonce":"abc","action":"restart"}"#,
        );
        assert_eq!(
            take_request(&path, 7, "abc").unwrap(),
            Some(DesktopControlAction::Restart)
        );
        assert!(!path.exists(), "a consumed request is removed");
        assert_eq!(take_request(&path, 7, "abc").unwrap(), None);
        write(
            &path,
            r#"{"schemaVersion":1,"launcherPid":7,"nonce":"abc","action":"quit"}"#,
        );
        assert_eq!(
            take_request(&path, 7, "abc").unwrap(),
            Some(DesktopControlAction::Quit)
        );
    }

    #[test]
    fn ignores_and_removes_foreign_or_malformed_requests() {
        let path = fixture("reject");
        for body in [
            r#"{"schemaVersion":1,"launcherPid":8,"nonce":"abc","action":"quit"}"#,
            r#"{"schemaVersion":1,"launcherPid":7,"nonce":"zzz","action":"quit"}"#,
            r#"{"schemaVersion":2,"launcherPid":7,"nonce":"abc","action":"quit"}"#,
            r#"{"schemaVersion":1,"launcherPid":7,"nonce":"abc","action":"format-disk"}"#,
            r#"{"schemaVersion":1,"launcherPid":7,"nonce":"abc","action":"quit","extra":1}"#,
            "not json",
        ] {
            write(&path, body);
            assert_eq!(take_request(&path, 7, "abc").unwrap(), None, "{body}");
            assert!(!path.exists(), "rejected request is removed: {body}");
        }
        write(
            &path,
            r#"{"schemaVersion":1,"launcherPid":7,"nonce":"","action":"quit"}"#,
        );
        assert_eq!(
            take_request(&path, 7, "").unwrap(),
            None,
            "an empty nonce never matches"
        );
    }

    #[test]
    fn drops_oversized_requests_without_reading_them() {
        let path = fixture("oversized");
        write(&path, &" ".repeat(5 * 1024));
        assert_eq!(take_request(&path, 7, "abc").unwrap(), None);
        assert!(!path.exists());
    }
}
