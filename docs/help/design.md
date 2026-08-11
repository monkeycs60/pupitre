# Claude Design

Claude Design n'existe que sur le web : ni API, ni CLI. La vue **Claude Design**
l'affiche dans la fenêtre de Pupitre, sur la zone de contenu, le rail restant
visible à sa gauche. Ce n'est pas un cadre HTML — claude.ai envoie
`X-Frame-Options: SAMEORIGIN`, qui interdit toute intégration par iframe. C'est
une vraie webview, posée par-dessus l'emplacement que la vue lui réserve.

Le panneau rouvre sur la dernière page Claude Design visitée plutôt que sur
l'écran d'accueil. Cette URL est mémorisée dans les réglages, et seules les pages
`claude.ai/design` sont acceptées : la valeur venant d'une navigation faite par
une page distante, elle est filtrée avant d'être enregistrée puis à nouveau avant
d'être ouverte.

Quitter la vue masque le panneau sans le fermer, donc y revenir est instantané et
ne recharge pas la page.

## Le panneau passe devant tout le reste

Une webview est une surface du système, pas un élément de la page : elle se
dessine au-dessus de l'interface de Pupitre, quel que soit l'ordre des calques.
La palette `Ctrl+K` et les modales masquent donc le panneau le temps qu'elles
sont ouvertes, et il revient à leur fermeture. Ce clignotement est le prix de
l'intégration, pas un défaut de réglage.

## Si le panneau se place mal

Tauri ne sait pas positionner une webview enfant sous Linux : il la construit
dans `window.default_vbox()`, une `GtkBox`, qui partage l'espace verticalement
entre ses enfants, et `set_bounds` n'y a aucun effet. Le panneau s'affichait donc
pleine largeur sous l'interface. C'est un problème connu en amont, ouvert depuis
juillet 2024 sous `tauri-apps/tauri#10420`.

Pupitre reprend donc ce placement à la main, en réarrangeant la hiérarchie GTK de
la fenêtre. Cela repose sur des détails d'implémentation que Tauri ne garantit
pas : une montée de version peut le casser. C'est pourquoi **Ouvrir dans une
fenêtre séparée** reste offert en permanence sous le panneau. Cette fenêtre est
le chemin qui fonctionnait avant, et elle continue de fonctionner.

## L'user-agent, et pourquoi ça peut casser

claude.ai refuse à l'entrée la signature de WebKitGTK, le moteur de webview de
Tauri sur Linux : le couple `X11; Linux` et `AppleWebKit` ne correspond à aucun
navigateur grand public, et reçoit un `403 Request not allowed`. Se déclarer
Chrome franchit ce filtre mais échoue ensuite en boucle sur le challenge
Cloudflare, dont le JavaScript teste le moteur réel et voit WebKit.

Pupitre annonce donc **Safari sur macOS** : la seule combinaison mesurée qui
franchisse les deux barrières, le moteur promis étant bien celui qui exécute la
page.

Ce filtre appartient à Anthropic. S'il se resserre, le panneau affichera un
message d'erreur de claude.ai et il n'y aura rien à réparer côté Pupitre — le
navigateur, lui, continuera de fonctionner. C'est pourquoi « Ouvrir dans le
navigateur » reste affiché en permanence plutôt que d'apparaître en cas d'échec :
le refus n'est pas détectable à l'avance. Une requête émise par le sidecar reçoit
un 403 même avec l'user-agent exact du panneau, Cloudflare discriminant sur
l'empreinte TLS, hors de portée d'un client qui n'est pas un navigateur.

## Session et reconnexion

Le panneau a son propre magasin de cookies, dans le répertoire de données de
l'application. Il faut donc s'y connecter une fois ; la session persiste ensuite
entre les lancements, et la fenêtre séparée la partage.

Sans session, claude.ai renvoie les visiteurs vers sa page marketing
`claude.com/product/design`. La vue le détecte en lisant l'URL atteinte côté Rust
— la page distante ne reçoit aucun accès IPC — et affiche un avertissement de
reconnexion. La détection est volontairement étroite : `claude.ai/login` et
`accounts.google.com` sont des étapes légitimes du flux de connexion, et alerter
dessus afficherait une erreur en pleine authentification.
