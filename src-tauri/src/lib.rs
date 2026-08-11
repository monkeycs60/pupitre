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

/// Étiquette de la fenêtre principale : la seule dont la fermeture arrête le
/// sidecar. Sans cette distinction, fermer la fenêtre Claude Design couperait
/// le backend de toute l'application.
const MAIN_WINDOW_LABEL: &str = "main";

const DESIGN_WINDOW_LABEL: &str = "design";

/// Webview enfant dockée dans la fenêtre principale. Étiquette distincte de la
/// fenêtre détachée : les deux peuvent coexister sans se marcher dessus.
const DESIGN_WEBVIEW_LABEL: &str = "design-dock";

/// Doit rester identique à `DESIGN_URL` dans `sidecar/src/design.ts`.
const DESIGN_URL: &str = "https://claude.ai/design/";

/// claude.ai refuse à l'entrée la signature d'user-agent de WebKitGTK, le
/// moteur de webview de Tauri sur Linux. Se déclarer Safari sur macOS est la
/// seule combinaison mesurée qui franchisse à la fois ce filtre et le challenge
/// Cloudflare : le moteur annoncé est alors bien celui qui exécute la page.
///
/// Doit rester identique à `DESIGN_USER_AGENT` dans `sidecar/src/design.ts` —
/// `sidecar/tests/design.test.ts` échoue si les deux chaînes divergent.
const DESIGN_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";

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
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), tauri_plugin_shell::Error>
{
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
                        log::warn!(
                            "Sidecar Pupitre arrêté ({:?}), relance planifiée",
                            payload.code
                        );
                    }
                    break;
                }
                CommandEvent::Error(error) => {
                    log::error!("Erreur du sidecar Pupitre : {error}");
                    terminal_error = true;
                    break;
                }
                CommandEvent::Stdout(output) => {
                    // Le canal doit être drainé en continu : sinon les pipes du
                    // processus finissent par bloquer quand leur buffer est plein.
                    log::info!(
                        "Sidecar Pupitre stdout: {}",
                        String::from_utf8_lossy(&output).trim_end(),
                    );
                }
                CommandEvent::Stderr(error) => {
                    // Les erreurs du sidecar étaient auparavant avalées, ce qui
                    // rendait une relance en boucle impossible à diagnostiquer.
                    log::error!(
                        "Sidecar Pupitre stderr: {}",
                        String::from_utf8_lossy(&error).trim_end(),
                    );
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

/// Ouvre Claude Design dans une fenêtre native dédiée, ou ramène au premier
/// plan celle qui existe déjà.
///
/// L'iframe est impossible : claude.ai envoie `X-Frame-Options: SAMEORIGIN` et
/// `Cross-Origin-Embedder-Policy: require-corp`. Il faut donc une vraie webview.
///
/// Elle ne reçoit aucune permission Tauri, et ce n'est pas dû au filtrage par
/// étiquette : une capability n'est retenue que si l'origine appelante matche son
/// contexte d'exécution, et une page distante ne matche qu'un contexte `Remote`
/// déclaré explicitement (`ipc::authority::Origin::matches`). `default.json`
/// n'ayant pas de champ `remote`, son contexte est `Local` : claude.ai n'a donc
/// accès à aucune commande. Y ajouter un `remote` ouvrirait l'IPC à la page.
#[tauri::command]
fn open_design_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DESIGN_WINDOW_LABEL) {
        let _ = window.unminimize();
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let url = DESIGN_URL
        .parse::<tauri::Url>()
        .map_err(|error| error.to_string())?;
    tauri::WebviewWindowBuilder::new(&app, DESIGN_WINDOW_LABEL, tauri::WebviewUrl::External(url))
        .title("Claude Design")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .user_agent(DESIGN_USER_AGENT)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn design_url() -> Result<tauri::Url, String> {
    DESIGN_URL
        .parse::<tauri::Url>()
        .map_err(|error| error.to_string())
}

/// Docke Claude Design dans la fenêtre principale, sur le rectangle que le
/// frontend réserve dans sa mise en page.
///
/// La webview enfant est créée au premier appel puis seulement déplacée : la
/// reconstruire à chaque redimensionnement rechargerait la page et ferait perdre
/// le travail en cours. Une webview est une surface de l'OS, dessinée AU-DESSUS
/// du DOM : c'est au frontend de la masquer quand il ouvre un overlay.
///
/// Sécurité : cette webview vit dans la fenêtre `main`, et `windows: ["main"]`
/// de `default.json` matche bel et bien toutes les webviews de cette fenêtre.
/// Ce qui la prive de permissions est son origine distante, qui ne matche aucune
/// capability à contexte `Local` — voir `open_design_window` ci-dessus.
#[tauri::command]
fn dock_design_webview(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // Une taille nulle ou négative fait échouer la création côté WebKitGTK, et
    // le frontend peut mesurer un rectangle vide pendant sa première frame.
    let width = width.max(1.0);
    let height = height.max(1.0);
    let position = tauri::LogicalPosition::new(x, y);
    let size = tauri::LogicalSize::new(width, height);

    if let Some(webview) = app.get_webview(DESIGN_WEBVIEW_LABEL) {
        webview
            .set_position(position)
            .map_err(|error| error.to_string())?;
        webview.set_size(size).map_err(|error| error.to_string())?;
        webview.show().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "fenêtre principale introuvable".to_string())?;
    window
        .add_child(
            tauri::webview::WebviewBuilder::new(
                DESIGN_WEBVIEW_LABEL,
                tauri::WebviewUrl::External(design_url()?),
            )
            .user_agent(DESIGN_USER_AGENT),
            position,
            size,
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Masque la webview dockée sans la détruire : quitter la vue Design ou ouvrir
/// la palette ne doit pas recharger claude.ai au retour.
#[tauri::command]
fn hide_design_webview(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(DESIGN_WEBVIEW_LABEL) {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// URL courante de la webview dockée, `None` si elle n'existe pas encore.
///
/// C'est ce qui permet de détecter la redirection vers la page marketing
/// `claude.com/product/design`, signe d'une session absente — sans accorder à
/// claude.ai le moindre accès IPC, puisque c'est Rust qui lit, pas la page qui
/// parle.
#[tauri::command]
fn design_webview_url(app: tauri::AppHandle) -> Option<String> {
    app.get_webview(DESIGN_WEBVIEW_LABEL)
        .and_then(|webview| webview.url().ok())
        .map(|url| url.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Taille, position et état maximisé sont restaurés au démarrage et
        // sauvegardés à la fermeture : repartir de 1280x800 à chaque lancement
        // était le comportement par défaut de Tauri.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            open_design_window,
            dock_design_webview,
            hide_design_webview,
            design_webview_url
        ])
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
            // La géométrie est enregistrée AVANT la destruction : `Destroyed`
            // arrive trop tard, la fenêtre n'a plus de taille à lire, et
            // l'application repartait donc de sa taille par défaut.
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                let _ = window.app_handle().save_window_state(StateFlags::all());
            }
            // Seule la fenêtre principale emporte le sidecar avec elle : depuis
            // l'ajout de la fenêtre Claude Design, arrêter le backend sur
            // n'importe quel `Destroyed` couperait toute l'application dès que
            // l'utilisateur referme Design.
            if matches!(event, tauri::WindowEvent::Destroyed)
                && window.label() == MAIN_WINDOW_LABEL
            {
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
