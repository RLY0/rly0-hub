use std::path::PathBuf;

/// One data root for Launcher children, independent services and the Updater.
pub fn rly0_data_directory() -> Option<PathBuf> {
    std::env::var_os("CODEXHOST_DATA_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .map(|home| home.join(crate::RLY0_HOME_DATA_DIRECTORY_NAME))
        })
}

/// Set child environments explicitly; never mutate the multithreaded process environment.
pub fn configure_rly0_data_directory(command: &mut std::process::Command) {
    if let Some(data) = rly0_data_directory() {
        command.env("CODEXHOST_DATA_DIR", data);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn defaults_to_hub_in_a_child_without_data_override() {
        use std::{env, fs, process::Command};
        if env::var_os("RLY0_DATA_TEST_CHILD").is_some() {
            assert!(env::var_os("CODEXHOST_DATA_DIR").is_none());
            let home = PathBuf::from(env::var_os("HOME").unwrap());
            assert!(home.starts_with(env::temp_dir()));
            assert_eq!(super::rly0_data_directory(), Some(home.join(".rly0-hub")));
            let mut command = Command::new("synthetic-not-executed");
            super::configure_rly0_data_directory(&mut command);
            assert!(command.get_envs().any(|(key, value)| {
                key == "CODEXHOST_DATA_DIR" && value == Some(home.join(".rly0-hub").as_os_str())
            }));
            return;
        }
        let home = crate::temporary_directory("rly0-default-data-synthetic");
        let output = Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "data_directory::tests::defaults_to_hub_in_a_child_without_data_override",
            ])
            .env_remove("CODEXHOST_DATA_DIR")
            .env("RLY0_DATA_TEST_CHILD", "1")
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .output()
            .unwrap();
        fs::remove_dir_all(home).unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    use std::path::PathBuf;
}
