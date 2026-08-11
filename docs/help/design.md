# Claude Design

Claude Design n'existe que sur le web : ni API, ni CLI. Pupitre l'ouvre donc dans
une fenêtre native dédiée, et la vue **Claude Design** en est le panneau de
pilotage. Ce n'est pas un cadre HTML — claude.ai envoie
`X-Frame-Options: SAMEORIGIN`, qui interdit toute intégration par iframe.

La fenêtre rouvre sur la dernière page Claude Design visitée plutôt que sur
l'écran d'accueil. Cette URL est mémorisée dans les réglages, et seules les pages
`claude.ai/design` sont acceptées : la valeur venant d'une navigation faite par
une page distante, elle est filtrée avant d'être enregistrée puis à nouveau avant
d'être ouverte.

## Pourquoi une fenêtre séparée et non un panneau intégré

Un panneau intégré a été tenté, puis abandonné sur constat technique. Le
multiwebview de Tauri ne sait pas se positionner sous Linux : une webview enfant
est construite dans `window.default_vbox()`, une `GtkBox`, où wry l'empaquette en
marquant `is_in_fixed_parent = false`. `set_bounds` n'y repositionne alors rien
en dehors du chemin X11, et la `GtkBox` partage l'espace verticalement entre les
deux webviews — le panneau s'affichait pleine largeur sous l'interface.

Y revenir demanderait de reparenter la webview dans un `GtkFixed` à la main, à
travers une API que Tauri qualifie lui-même d'inachevée.

## L'user-agent, et pourquoi ça peut casser

claude.ai refuse à l'entrée la signature de WebKitGTK, le moteur de webview de
Tauri sur Linux : le couple `X11; Linux` et `AppleWebKit` ne correspond à aucun
navigateur grand public, et reçoit un `403 Request not allowed`. Se déclarer
Chrome franchit ce filtre mais échoue ensuite en boucle sur le challenge
Cloudflare, dont le JavaScript teste le moteur réel et voit WebKit.

Pupitre annonce donc **Safari sur macOS** : la seule combinaison mesurée qui
franchisse les deux barrières, le moteur promis étant bien celui qui exécute la
page.

Ce filtre appartient à Anthropic. S'il se resserre, la fenêtre affichera un
message d'erreur de claude.ai et il n'y aura rien à réparer côté Pupitre — le
navigateur, lui, continuera de fonctionner. C'est pourquoi « Ouvrir dans le
navigateur » reste affiché en permanence plutôt que d'apparaître en cas d'échec :
le refus n'est pas détectable à l'avance. Une requête émise par le sidecar reçoit
un 403 même avec l'user-agent exact de la fenêtre, Cloudflare discriminant sur
l'empreinte TLS, hors de portée d'un client qui n'est pas un navigateur.

## Session et reconnexion

La fenêtre a son propre magasin de cookies, dans le répertoire de données de
l'application. Il faut donc s'y connecter une fois ; la session persiste ensuite
entre les lancements.

Sans session, claude.ai renvoie les visiteurs vers sa page marketing
`claude.com/product/design`. La vue le détecte en lisant l'URL atteinte côté Rust
— la page distante ne reçoit aucun accès IPC — et affiche un avertissement de
reconnexion. La détection est volontairement étroite : `claude.ai/login` et
`accounts.google.com` sont des étapes légitimes du flux de connexion, et alerter
dessus afficherait une erreur en pleine authentification.
