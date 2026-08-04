use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct SidecarProcess(Mutex<Option<CommandChild>>);

fn stop_sidecar(app: &tauri::AppHandle) {
    let sidecar = app.state::<SidecarProcess>();
    if let Ok(mut child_slot) = sidecar.0.lock() {
        if let Some(child) = child_slot.take() {
            let _ = child.kill();
        }
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;

                let repository_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .expect("src-tauri doit être situé à la racine du dépôt");
                let sidecar_directory = repository_root.join("sidecar");
                let command = app.shell().command("bun").args([
                    "run".to_string(),
                    "--cwd".to_string(),
                    sidecar_directory.to_string_lossy().into_owned(),
                    "src/index.ts".to_string(),
                ]);
                let (_events, child) = command.spawn()?;
                app.manage(SidecarProcess(Mutex::new(Some(child))));
            }

            #[cfg(not(debug_assertions))]
            {
                let command = app.shell().sidecar("pupitre-sidecar")?;
                let (_events, child) = command.spawn()?;
                app.manage(SidecarProcess(Mutex::new(Some(child))));
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                stop_sidecar(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            stop_sidecar(app_handle);
        }
    });
}
