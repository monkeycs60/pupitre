use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

struct SidecarProcess {
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
}

impl Default for SidecarProcess {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
        }
    }
}

fn stop_sidecar(app: &tauri::AppHandle) {
    let sidecar = app.state::<SidecarProcess>();
    sidecar.stopping.store(true, Ordering::Release);
    if let Ok(mut child_slot) = sidecar.child.lock() {
        if let Some(child) = child_slot.take() {
            // SIGTERM d'abord : le sidecar arrête proprement l'app-server codex
            // et son groupe de serveurs MCP, sinon laissés orphelins à chaque
            // fermeture de l'app. Le kill ne reste qu'un filet de sécurité.
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &child.pid().to_string()])
                    .status();
                std::thread::sleep(Duration::from_millis(300));
            }
            let _ = child.kill();
        }
    };
}

fn spawn_sidecar(
    app: &tauri::AppHandle,
) -> Result<(
    tauri::async_runtime::Receiver<CommandEvent>,
    CommandChild,
), tauri_plugin_shell::Error> {
    #[cfg(debug_assertions)]
    {
        let repository_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri doit être situé à la racine du dépôt");
        let sidecar_directory = repository_root.join("sidecar");
        return app
            .shell()
            .command("bun")
            .args([
                "run".to_string(),
                "--cwd".to_string(),
                sidecar_directory.to_string_lossy().into_owned(),
                "src/index.ts".to_string(),
            ])
            .spawn();
    }

    #[cfg(not(debug_assertions))]
    app.shell().sidecar("pupitre-sidecar")?.spawn()
}

fn supervise_sidecar(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let state = app.state::<SidecarProcess>();
        if state.stopping.load(Ordering::Acquire) {
            break;
        }

        // Le spawn a lieu sous le mutex, sans jamais rendre la main entre la
        // création du processus et son enregistrement : un arrêt concurrent
        // attend le verrou puis récupère forcément le child. Le tuer ici après
        // coup ne suffirait pas, car l'arrêt de l'application peut terminer le
        // processus avant que ce thread ne soit réordonnancé, laissant un
        // sidecar orphelin sur le port.
        let spawned = match state.child.lock() {
            Ok(mut child_slot) => {
                if state.stopping.load(Ordering::Acquire) {
                    break;
                }
                match spawn_sidecar(&app) {
                    Ok((events, child)) => {
                        *child_slot = Some(child);
                        Some(events)
                    }
                    Err(error) => {
                        log::error!("Impossible de lancer le sidecar Pupitre : {error}");
                        None
                    }
                }
            }
            Err(_) => break,
        };
        let Some(mut events) = spawned else {
            std::thread::sleep(Duration::from_secs(1));
            continue;
        };

        let mut terminal_error = false;
        let mut intentional_exit = false;
        while let Some(event) = tauri::async_runtime::block_on(events.recv()) {
            match event {
                CommandEvent::Terminated(payload) => {
                    // Un exit 0 est volontaire : sidecar évincé par une instance
                    // plus récente (POST /api/shutdown) ou arrêté proprement. Le
                    // relancer déclencherait une guerre d'éviction entre
                    // instances ; on le laisse mort.
                    if payload.code == Some(0) {
                        log::info!("Sidecar Pupitre arrêté volontairement, pas de relance");
                        intentional_exit = true;
                    } else {
                        log::warn!("Sidecar Pupitre arrêté ({:?}), relance planifiée", payload.code);
                    }
                    break;
                }
                CommandEvent::Error(error) => {
                    log::error!("Erreur du sidecar Pupitre : {error}");
                    terminal_error = true;
                    break;
                }
                CommandEvent::Stdout(_) | CommandEvent::Stderr(_) => {
                    // Le canal doit être drainé en continu : sinon les pipes du
                    // processus finissent par bloquer quand leur buffer est plein.
                }
                _ => {}
            }
        }

        if let Ok(mut child_slot) = state.child.lock() {
            if let Some(child) = child_slot.take() {
                if terminal_error {
                    let _ = child.kill();
                }
            }
        }
        if state.stopping.load(Ordering::Acquire) || intentional_exit {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            app.manage(SidecarProcess::default());
            supervise_sidecar(app.handle().clone());
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
