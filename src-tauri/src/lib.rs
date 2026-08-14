mod design_panel;

use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::webview::DownloadEvent;
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

/// Préfixe des étiquettes des popups de connexion, qui sert aussi à les
/// retrouver pour les fermer.
const DESIGN_POPUP_LABEL_PREFIX: &str = "design-popup-";

/// Compteur d'étiquettes des popups de connexion : Tauri refuse deux fenêtres de
/// même étiquette, et un flux OAuth peut en ouvrir plusieurs à la suite.
static DESIGN_POPUP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Les webviews Claude n'ont pas de navigateur hôte pour prendre en charge le
/// signal de téléchargement. Le hook Tauri conserve le nom proposé par Claude
/// et laisse Wry choisir le dossier `Downloads` de l'utilisateur.
fn handle_design_download<R: tauri::Runtime>(
    _webview: tauri::Webview<R>,
    event: DownloadEvent<'_>,
) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            log::info!(
                "Téléchargement Claude Design demandé : {url} vers {}",
                destination.display()
            );
        }
        DownloadEvent::Finished { url, path, success } => {
            log::info!(
                "Téléchargement Claude Design terminé : {url} vers {path:?} (succès : {success})"
            );
        }
        _ => {}
    }

    true
}

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

/// WebKitGTK peut livrer un événement `paste` vide pour une image pourtant
/// présente dans le presse-papiers système. Claude Design écoute cet événement
/// pour créer sa pièce jointe, il faut donc lui fournir un second événement avec
/// le `File` récupéré par l'Async Clipboard API.
const DESIGN_CLIPBOARD_SCRIPT: &str = r#"
(() => {
  if (location.hostname !== 'claude.ai' || window.__pupitreClipboardBridge) return;
  window.__pupitreClipboardBridge = true;

  window.addEventListener('paste', (event) => {
    const types = Array.from(event.clipboardData?.types ?? []);
    const hasImageType = types.some((type) => type.startsWith('image/'));
    if (hasImageType) return;

    // Un événement sans type est le symptôme WebKitGTK recherché. Ne bloquer
    // un collage texte que si le navigateur n'a rien exposé du tout.
    if (types.length > 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    void (async () => {
      if (typeof navigator.clipboard?.read !== 'function') return;

      try {
        const clipboardItems = await navigator.clipboard.read();
        let imageBlob = null;
        let imageType = '';
        for (const item of clipboardItems) {
          const type = item.types.find((candidate) => candidate.startsWith('image/'));
          if (!type) continue;
          imageBlob = await item.getType(type);
          imageType = type;
          break;
        }
        if (!imageBlob) return;

        const extension = imageType === 'image/jpeg'
          ? 'jpg'
          : imageType.split('/')[1] || 'png';
        const file = new File([imageBlob], `capture.${extension}`, { type: imageType });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const target = event.target instanceof EventTarget
          ? event.target
          : document.activeElement || document.body;
        target.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
          composed: true,
        }));
      } catch {
        // Le collage texte et le bouton d'ajout natif restent disponibles si
        // l'Async Clipboard API est refusée par le moteur ou la page.
      }
    })();
  }, true);
})();
"#;

#[derive(serde::Serialize)]
struct ClipboardImage {
    mime_type: String,
    data: Vec<u8>,
}

#[cfg(target_os = "linux")]
fn read_clipboard_command(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    Some(output.stdout)
}

#[cfg(target_os = "linux")]
fn read_linux_clipboard_image() -> Option<ClipboardImage> {
    // Claude Design and the main window are two separate WebViews. WebKitGTK
    // does not consistently expose an image copied by the child WebView to the
    // parent's ClipboardEvent, so read the shared desktop clipboard as a
    // fallback. Keep the format list small: these are accepted by the media
    // upload endpoint and cover screenshots from the supported desktop tools.
    const IMAGE_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];

    for mime_type in IMAGE_TYPES {
        if let Some(data) =
            read_clipboard_command("wl-paste", &["--no-newline", "--type", mime_type])
        {
            return Some(ClipboardImage {
                mime_type: mime_type.to_string(),
                data,
            });
        }
    }

    // X11 remains a valid fallback when the app is launched through XWayland
    // or on an X11 session without wl-clipboard installed.
    for mime_type in IMAGE_TYPES {
        if let Some(data) = read_clipboard_command(
            "xclip",
            &["-selection", "clipboard", "-target", mime_type, "-out"],
        ) {
            return Some(ClipboardImage {
                mime_type: mime_type.to_string(),
                data,
            });
        }
    }

    None
}

#[tauri::command]
fn read_clipboard_image() -> Result<Option<ClipboardImage>, String> {
    #[cfg(target_os = "linux")]
    {
        return Ok(read_linux_clipboard_image());
    }

    #[cfg(not(target_os = "linux"))]
    {
        // The browser Clipboard API remains the first path on other platforms.
        Ok(None)
    }
}

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

/// Redémarre le backend supervisé sans fermer la fenêtre principale. Le
/// superviseur observe la terminaison non volontaire puis recrée le processus.
#[tauri::command]
fn restart_sidecar(app: tauri::AppHandle) -> Result<(), String> {
    let sidecar = app.state::<SidecarProcess>();
    if sidecar.stopping.load(Ordering::Acquire) {
        return Err("Pupitre est en cours d’arrêt".to_string());
    }
    let child_slot = sidecar
        .child
        .lock()
        .map_err(|_| "Sidecar indisponible".to_string())?;
    let child = child_slot
        .as_ref()
        .ok_or_else(|| "Sidecar non démarré".to_string())?;

    #[cfg(unix)]
    {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &child.pid().to_string()])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("Impossible d’arrêter le sidecar".to_string());
        }
    }
    #[cfg(not(unix))]
    child.kill().map_err(|error| error.to_string())?;

    Ok(())
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
                    // Le sidecar encode la cause de son arrêt dans son code de
                    // sortie (voir KILLED_EXIT_CODE) : 0 signifie « évincé par
                    // une instance plus récente via POST /api/shutdown », et le
                    // relancer déclencherait une guerre d'éviction. Tout autre
                    // code — dont 143, un SIGTERM reçu de l'extérieur — est une
                    // mort subie : on relance, sinon l'app reste sans backend.
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
///
/// Cette fenêtre n'est plus la voie normale : le panneau intégré de
/// `design_panel.rs` l'est. Elle reste le repli, à ne pas supprimer. Le placement
/// du panneau repose sur un réarrangement de la hiérarchie GTK, donc sur des
/// détails d'implémentation de Tauri et de wry ; si une montée de version le
/// casse, cette fenêtre est ce qui garde Claude Design accessible en attendant.
///
/// `resume_url` rouvre la dernière page Claude Design visitée plutôt que
/// l'écran d'accueil, si elle franchit `resumable_design_url`.
#[tauri::command]
fn open_design_window(app: tauri::AppHandle, resume_url: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DESIGN_WINDOW_LABEL) {
        let _ = window.unminimize();
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let target = match resumable_design_url(resume_url) {
        Some(url) => url,
        None => design_url()?,
    };
    let popup_app = app.clone();
    tauri::WebviewWindowBuilder::new(
        &app,
        DESIGN_WINDOW_LABEL,
        tauri::WebviewUrl::External(target),
    )
    .title("Claude Design")
    .inner_size(1280.0, 860.0)
    .min_inner_size(900.0, 600.0)
    .user_agent(DESIGN_USER_AGENT)
    .enable_clipboard_access()
    .initialization_script(DESIGN_CLIPBOARD_SCRIPT)
    .on_download(handle_design_download)
    // Sans ce gestionnaire, la connexion est impossible : wry ne branche le signal
    // `create` de WebKit que si un handler existe, donc un `window.open` de
    // claude.ai est purement ignoré et le flux OAuth échoue sans rien afficher.
    //
    // `window_features` est ce qui rend la popup utilisable : sur Linux il appelle
    // `with_related_view`, qui la fait partager le processus web de la fenêtre
    // appelante. Sans ce lien, la popup n'a ni la session ni la relation d'opener
    // qu'attend le flux, et Google renvoie une erreur de connexion.
    .on_new_window(move |url, features| build_design_popup(&popup_app, url, features))
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Construit la popup d'un flux de connexion Claude, pour la fenêtre séparée
/// comme pour le panneau intégré.
///
/// Partagée à dessein : les deux surfaces mènent le même flux OAuth, et une
/// divergence entre elles se paierait par un « Une erreur s'est produite lors de
/// la connexion » impossible à relier à sa cause.
pub(crate) fn build_design_popup<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<R> {
    let label = format!(
        "{DESIGN_POPUP_LABEL_PREFIX}{}",
        DESIGN_POPUP_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let built = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(url))
        .window_features(features)
        .title("Connexion à Claude")
        // Le même user-agent que la surface parente : c'est lui qui fait passer
        // le flux, et une popup qui se déclarerait autrement serait refusée.
        .user_agent(DESIGN_USER_AGENT)
        .enable_clipboard_access()
        .initialization_script(DESIGN_CLIPBOARD_SCRIPT)
        .on_download(handle_design_download)
        .build();
    match built {
        Ok(window) => tauri::webview::NewWindowResponse::Create { window },
        Err(error) => {
            log::error!("Popup de connexion Claude Design refusée : {error}");
            tauri::webview::NewWindowResponse::Deny
        }
    }
}

/// Ouvre Claude Design dans la fenêtre principale, sur la zone de contenu, le
/// rail restant visible à sa gauche.
///
/// C'est la voie normale ; `open_design_window` n'est plus qu'un repli. Le
/// placement ne vient pas de Tauri, qui ne sait pas positionner une webview
/// enfant sous Linux, mais de `design_panel.rs` — lire son en-tête avant toute
/// modification, la raison y est mesurée sur les sources.
#[tauri::command]
fn open_design_panel(app: tauri::AppHandle, resume_url: Option<String>) -> Result<(), String> {
    let target = match resumable_design_url(resume_url) {
        Some(url) => url,
        None => design_url()?,
    };
    design_panel::open(&app, target)
}

/// Place le panneau sur la zone de contenu, en pixels logiques lus par le
/// frontend sur l'emplacement qu'il réserve dans le DOM.
#[tauri::command]
fn set_design_panel_bounds(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    design_panel::set_bounds(&app, x, y, width, height)
}

/// Masque ou réaffiche le panneau.
///
/// À appeler à chaque ouverture de calque : la webview est une surface de l'OS,
/// elle se dessine au-dessus du DOM, donc la palette et les modales s'ouvriraient
/// derrière elle.
#[tauri::command]
fn set_design_panel_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    design_panel::set_visible(&app, visible)
}

#[tauri::command]
fn close_design_panel(app: tauri::AppHandle) -> Result<(), String> {
    design_panel::close(&app)
}

/// URL courante du panneau, `None` s'il est fermé.
///
/// Même rôle que `design_webview_url` pour la fenêtre séparée : détecter la
/// redirection vers la page marketing, signe d'une session absente, et alimenter
/// l'URL de reprise. C'est Rust qui lit, la page ne reçoit aucun IPC.
#[tauri::command]
fn design_panel_url(app: tauri::AppHandle) -> Option<String> {
    design_panel::url(&app)
}

fn design_url() -> Result<tauri::Url, String> {
    DESIGN_URL
        .parse::<tauri::Url>()
        .map_err(|error| error.to_string())
}

/// Filtre l'URL de reprise proposée par le frontend, et n'en garde que ce qui
/// est réellement une page Claude Design.
///
/// Cette valeur est née d'une navigation effectuée par une page distante, a
/// transité par le frontend et dormi en base : la faire suivre sans contrôle
/// ouvrirait la webview n'importe où, avec l'user-agent falsifié de Pupitre.
/// La même règle existe dans `sidecar/src/design.ts` et
/// `ui/src/designSession.ts` ; elle est répétée ici parce que Rust est le seul
/// point où elle est appliquée juste avant la navigation.
fn resumable_design_url(candidate: Option<String>) -> Option<tauri::Url> {
    let url = candidate?.parse::<tauri::Url>().ok()?;
    if url.scheme() != "https" || url.host_str() != Some("claude.ai") {
        return None;
    }
    if url.path() != "/design" && !url.path().starts_with("/design/") {
        return None;
    }
    Some(url)
}

/// Ferme les popups de connexion restées vides à l'écran.
///
/// En fin de flux OAuth, la page appelle `window.close()`. wry y répond par un
/// `webview.destroy()` seul : la webview disparaît, mais la fenêtre qui la
/// contenait reste affichée, vide. Le frontend appelle donc cette commande quand
/// la fenêtre principale a atteint une page Claude Design — signe que le flux est
/// terminé et qu'aucune popup n'est plus en cours d'utilisation.
///
/// Passer par les étiquettes plutôt que par le signal `close` de WebKit évite
/// d'ajouter `webkit2gtk` en dépendance directe, dont la version devrait suivre
/// exactement celle de Tauri.
#[tauri::command]
fn close_design_popups(app: tauri::AppHandle) -> usize {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(DESIGN_POPUP_LABEL_PREFIX))
        .filter(|(_, window)| window.close().is_ok())
        .count()
}

/// URL courante de la fenêtre Claude Design, `None` si elle n'est pas ouverte.
///
/// C'est ce qui permet de détecter la redirection vers la page marketing
/// `claude.com/product/design`, signe d'une session absente — sans accorder à
/// claude.ai le moindre accès IPC, puisque c'est Rust qui lit, pas la page qui
/// parle. C'est aussi la source de l'URL de reprise.
#[tauri::command]
fn design_webview_url(app: tauri::AppHandle) -> Option<String> {
    app.get_webview_window(DESIGN_WINDOW_LABEL)
        .and_then(|window| window.url().ok())
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
            open_design_panel,
            set_design_panel_bounds,
            set_design_panel_visible,
            close_design_panel,
            design_panel_url,
            open_design_window,
            close_design_popups,
            design_webview_url,
            restart_sidecar,
            read_clipboard_image
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
