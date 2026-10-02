pub fn configure() {
    #[cfg(target_os = "macos")]
    {
        use std::path::PathBuf;
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let mut paths = Vec::new();
        if let Some(home) = home {
            if let Ok(path) = std::fs::read_to_string(home.join(".config/pupitre/path")) {
                paths.extend(std::env::split_paths(path.trim()));
            }
            for directory in [".local/bin", ".bun/bin", ".cargo/bin"] {
                paths.push(home.join(directory));
            }
        }
        for directory in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            paths.push(PathBuf::from(directory));
        }
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        // Finder n'hérite pas du PATH du terminal. Le setup installe les CLIs
        // dans ces emplacements sans demander de modifier le shell utilisateur.
        if let Ok(path) = std::env::join_paths(paths) {
            std::env::set_var("PATH", path);
        }
    }
}
