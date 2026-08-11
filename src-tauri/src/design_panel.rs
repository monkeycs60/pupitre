//! Claude Design intégré à la fenêtre principale, en webview enfant.
//!
//! # Pourquoi ce module existe
//!
//! Tauri sait créer une webview enfant (`Window::add_child`, feature `unstable`),
//! mais il ne sait pas la positionner sous Linux. La chaîne, relue dans les
//! sources vendorisées :
//!
//! 1. `tauri-runtime-wry-2.11.4/src/lib.rs:5225` — pour un `WebviewKind::WindowChild`
//!    sur Linux, Tauri construit la webview dans `window.default_vbox()`, une
//!    `GtkBox`. L'arme `build_as_child` est gardée derrière un `cfg` Windows /
//!    macOS / iOS / Android, donc inatteignable ici.
//! 2. `wry-0.55.1/src/webkitgtk/mod.rs:590` — `add_to_container` y fait un
//!    `pack_start` et laisse `is_in_fixed_parent = false`.
//! 3. `wry-0.55.1/src/webkitgtk/mod.rs:853` — `set_bounds` ne repositionne que si
//!    `x11` est peuplé ou si `is_in_fixed_parent`. Aucun des deux ici.
//!
//! La `GtkBox` étant verticale, elle partage l'espace entre ses deux enfants :
//! le panneau s'affichait pleine largeur sous l'interface. C'est le symptôme
//! décrit par l'issue amont `tauri-apps/tauri#10420`, ouverte depuis juillet 2024
//! et toujours ouverte.
//!
//! Le chemin `x11` de `set_bounds` n'est pas une échappatoire, et ce n'est pas la
//! peine de tenter `GDK_BACKEND=x11` : `x11` n'est renseigné que dans
//! `new_x11`, atteint par `new` et `new_as_child`, que Tauri n'appelle jamais sur
//! Linux. `new_gtk`, le seul chemin emprunté, écrit `x11: None` en dur
//! (`wry-0.55.1/src/webkitgtk/mod.rs:337`). La branche est structurellement morte
//! pour une webview enfant, quel que soit le backend GDK.
//!
//! # Ce que fait ce module
//!
//! Il reprend la géométrie à la main, en réarrangeant la hiérarchie GTK que Tauri
//! nous expose publiquement — `Window::default_vbox`, `PlatformWebview::inner`.
//! Il n'y a ni `unsafe` ni FFI : on demande le conteneur, on demande la webview,
//! on déplace.
//!
//! Le conteneur retenu est une `GtkOverlay` plutôt que la `GtkFixed` évoquée en
//! amont, pour une raison de mode de défaillance. Une `GtkFixed` demanderait d'y
//! ranger aussi la webview principale et de lui recalculer sa taille à chaque
//! redimensionnement : une erreur de calcul casserait alors toute l'interface de
//! Pupitre, pas seulement le panneau. Avec une `GtkOverlay`, la webview
//! principale reste l'enfant principal et garde son allocation GTK normale ; le
//! panneau flotte au-dessus. Si son placement dérape, Pupitre reste utilisable.
//!
//! Si la `GtkOverlay` se révélait inadaptée, le repli documenté est la `GtkFixed`,
//! avec un avertissement issu de la PR amont `tauri-apps/wry#1745` : `size_allocate`
//! n'y suffit pas, la `GtkFixed` replace son enfant à la coordonnée de son `put`
//! au relayout suivant. Il faut `gtk::Fixed::move_`.
//!
//! # Ce qui reste à la charge de l'appelant
//!
//! Une webview est une surface de l'OS : elle se dessine au-dessus du DOM, donc
//! au-dessus de la palette et des modales. Le frontend doit appeler
//! `set_design_panel_visible(false)` à l'ouverture de tout calque. Ce coût n'est
//! pas propre à ce module, il vaudrait aussi pour un correctif amont : c'est la
//! nature du multiwebview.

use gtk::prelude::*;
use tauri::Manager;

use crate::{DESIGN_USER_AGENT, MAIN_WINDOW_LABEL};

/// Étiquette de la webview enfant. Distincte de `DESIGN_WINDOW_LABEL` : le
/// panneau et la fenêtre séparée peuvent coexister, et Tauri refuse deux
/// webviews de même étiquette.
pub const DESIGN_PANEL_LABEL: &str = "design-panel";

/// Rend le panneau utilisable, en le créant s'il n'existe pas encore.
///
/// Idempotent : rappelé sur un panneau vivant, il se contente de le réafficher.
/// C'est ce qui permet de quitter la vue Design et d'y revenir sans recharger la
/// page, la webview étant seulement masquée entre-temps.
///
/// `resume_url` a déjà été filtrée par `resumable_design_url` côté appelant.
pub fn open(app: &tauri::AppHandle, target: tauri::Url) -> Result<(), String> {
    if app.get_webview(DESIGN_PANEL_LABEL).is_some() {
        // Réaffichage seul, par GTK et non par `Webview::show` : les deux visent le
        // même widget, mais elles sont dépêchées séparément sur le thread principal
        // et rien n'en garantit l'ordre. Une seule voie, celle qui sert déjà au
        // masquage sur calque.
        return set_visible(app, true);
    }

    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Fenêtre principale introuvable".to_string())?;

    let popup_app = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(
        DESIGN_PANEL_LABEL,
        tauri::WebviewUrl::External(target),
    )
    .user_agent(DESIGN_USER_AGENT)
    // Même raison que pour la fenêtre séparée : wry ne branche le signal `create`
    // de WebKit que si un gestionnaire existe, donc sans lui un `window.open` de
    // claude.ai est ignoré et le flux OAuth échoue sans rien afficher. Et
    // `window_features` appelle `with_related_view` sur Linux, ce qui donne à la
    // popup le processus web de l'appelante, donc sa session et sa relation
    // d'opener.
    .on_new_window(move |url, features| crate::build_design_popup(&popup_app, url, features));

    // La position et la taille passées ici ne servent à rien sous Linux, pour la
    // raison exposée en tête de module. Le premier `set_bounds` du frontend fait
    // foi. On donne quand même des valeurs plausibles plutôt que zéro : une
    // webview de taille nulle a un comportement erratique côté WebKit.
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(800.0, 600.0),
        )
        .map_err(|error| error.to_string())?;

    install_in_overlay(app)
}

/// Réarrange la hiérarchie GTK pour que le panneau flotte au-dessus de
/// l'interface au lieu de lui voler la moitié de la fenêtre.
///
/// Tout se fait dans la fermeture de `with_webview` : elle est dépêchée sur le
/// thread principal, et les widgets GTK ne sont pas `Send`. On part de la webview
/// du panneau et on remonte à son parent plutôt que d'appeler `default_vbox` :
/// c'est le même widget, et cela garantit qu'on manipule bien le conteneur où
/// Tauri vient de la ranger.
fn install_in_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    let webview = app
        .get_webview(DESIGN_PANEL_LABEL)
        .ok_or_else(|| "Panneau Claude Design introuvable après création".to_string())?;

    webview
        .with_webview(|platform| {
            let panel = platform.inner();
            let panel_widget = panel.clone().upcast::<gtk::Widget>();

            let Some(vbox) = panel_widget
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Box>().ok())
            else {
                log::error!(
                    "Panneau Claude Design : parent GTK inattendu, placement abandonné. \
                     La fenêtre séparée reste disponible."
                );
                return;
            };

            // Deuxième ouverture : l'overlay est déjà en place, la webview
            // principale y est déjà, il ne reste qu'à y verser le panneau.
            let overlay = match vbox
                .children()
                .into_iter()
                .find_map(|child| child.downcast::<gtk::Overlay>().ok())
            {
                Some(overlay) => overlay,
                None => {
                    // L'autre webview de la vbox est celle de Pupitre. On la
                    // reconnaît à son type plutôt qu'à sa position : Tauri se
                    // réserve la vbox pour d'autres widgets, dont la barre de
                    // menu, et l'ordre n'est garanti nulle part.
                    let Some(main_widget) = vbox.children().into_iter().find(|child| {
                        child != &panel_widget && child.is::<webkit2gtk::WebView>()
                    }) else {
                        log::error!(
                            "Panneau Claude Design : webview principale introuvable dans la vbox, \
                             placement abandonné."
                        );
                        return;
                    };

                    let overlay = gtk::Overlay::new();
                    vbox.remove(&main_widget);
                    overlay.add(&main_widget);
                    vbox.pack_start(&overlay, true, true, 0);
                    overlay
                }
            };

            vbox.remove(&panel_widget);
            overlay.add_overlay(&panel_widget);

            // L'ancrage en haut à gauche est ce qui rend les marges lisibles comme
            // des coordonnées : sans lui, GTK centre l'enfant flottant et les
            // marges ne feraient que le décaler depuis le centre.
            panel_widget.set_halign(gtk::Align::Start);
            panel_widget.set_valign(gtk::Align::Start);

            overlay.show_all();
        })
        .map_err(|error| error.to_string())
}

/// Place le panneau sur la zone de contenu, en pixels logiques.
///
/// Les valeurs viennent du `getBoundingClientRect` de l'emplacement réservé dans
/// le DOM. Les pixels CSS et les unités GTK sont tous deux logiques, donc aucune
/// correction d'échelle n'est à appliquer ici — une conversion HiDPI a été une
/// fausse piste lors d'un chantier précédent, ne pas la réintroduire.
///
/// La position passe par les marges et non par `Webview::set_position`, qui est
/// inerte sous Linux ; la taille par `set_size_request` et non par
/// `Webview::set_size`, inerte pour la même raison.
pub fn set_bounds(
    app: &tauri::AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let webview = app
        .get_webview(DESIGN_PANEL_LABEL)
        .ok_or_else(|| "Panneau Claude Design fermé".to_string())?;

    // Une taille nulle ou négative fait déraper WebKit ; on plancher à 1.
    let width = width.max(1);
    let height = height.max(1);
    let x = x.max(0);
    let y = y.max(0);

    webview
        .with_webview(move |platform| {
            let widget = platform.inner().upcast::<gtk::Widget>();
            widget.set_margin_start(x);
            widget.set_margin_top(y);
            widget.set_size_request(width, height);
        })
        .map_err(|error| error.to_string())
}

/// Masque ou réaffiche le panneau.
///
/// Indispensable, et pas seulement pour quitter la vue : une webview est une
/// surface de l'OS, elle se dessine au-dessus du DOM. Sans ce masquage, la
/// palette et les modales de Pupitre s'ouvriraient derrière le panneau.
pub fn set_visible(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    let webview = app
        .get_webview(DESIGN_PANEL_LABEL)
        .ok_or_else(|| "Panneau Claude Design fermé".to_string())?;

    webview
        .with_webview(move |platform| {
            let widget = platform.inner().upcast::<gtk::Widget>();
            if visible {
                widget.show();
            } else {
                widget.hide();
            }
        })
        .map_err(|error| error.to_string())
}

/// Détruit le panneau.
///
/// L'overlay installé dans la vbox reste en place, avec la seule webview
/// principale : elle y garde son allocation pleine fenêtre, donc il n'y a rien à
/// défaire. Une réouverture ultérieure retrouvera cet overlay et s'y greffera.
pub fn close(app: &tauri::AppHandle) -> Result<(), String> {
    match app.get_webview(DESIGN_PANEL_LABEL) {
        Some(webview) => webview.close().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

/// URL courante du panneau, `None` s'il est fermé.
///
/// C'est Rust qui lit, jamais la page qui parle : claude.ai n'a accès à aucune
/// commande Tauri, et il ne faut surtout pas lui en ouvrir. Voir la note sur les
/// capabilities dans `lib.rs`.
pub fn url(app: &tauri::AppHandle) -> Option<String> {
    app.get_webview(DESIGN_PANEL_LABEL)
        .and_then(|webview| webview.url().ok())
        .map(|url| url.to_string())
}
