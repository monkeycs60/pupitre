#[cfg(debug_assertions)]
use std::{
    process::{Child, Command},
    sync::Mutex,
};
#[cfg(debug_assertions)]
use tauri::Manager;

#[cfg(debug_assertions)]
struct SidecarProcess(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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

                // Le packaging du sidecar en binaire embarqué (`bun build --compile`
                // + `externalBin`) est volontairement hors périmètre du M1.
                let child = Command::new("bun")
                    .arg("run")
                    .arg("--cwd")
                    .arg(sidecar_directory)
                    .arg("src/index.ts")
                    .spawn()?;

                app.manage(SidecarProcess(Mutex::new(Some(child))));
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(debug_assertions)]
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let sidecar = window.app_handle().state::<SidecarProcess>();

                if let Ok(mut child_slot) = sidecar.0.lock() {
                    if let Some(mut child) = child_slot.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
