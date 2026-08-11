# Claude Design

Claude Design n'existe que sur le web : ni API, ni CLI. Pupitre l'embarque donc
dans une webview native, dockée sur la zone de contenu de la fenêtre. Ce n'est
pas un cadre HTML — claude.ai envoie `X-Frame-Options: SAMEORIGIN`, qui interdit
toute intégration par iframe.

La vue s'ouvre sur la dernière page Claude Design visitée plutôt que sur l'écran
d'accueil. Cette URL est mémorisée dans les réglages, et seules les pages
`claude.ai/design` sont acceptées : la valeur venant d'une navigation faite par
une page distante, elle est filtrée avant d'être enregistrée puis à nouveau avant
d'être ouverte.

## L'user-agent, et pourquoi ça peut casser

claude.ai refuse à l'entrée la signature de WebKitGTK, le moteur de webview de
Tauri sur Linux : le couple `X11; Linux` et `AppleWebKit` ne correspond à aucun
navigateur grand public, et reçoit un `403 Request not allowed`. Se déclarer
Chrome franchit ce filtre mais échoue ensuite en boucle sur le challenge
Cloudflare, dont le JavaScript teste le moteur réel et voit WebKit.

Pupitre annonce donc **Safari sur macOS** : la seule combinaison mesurée qui
franchisse les deux barrières, le moteur promis étant bien celui qui exécute la
page.

Ce filtre appartient à Anthropic. S'il se resserre, la webview affichera un
message d'erreur de claude.ai et il n'y aura rien à réparer côté Pupitre — le
navigateur, lui, continuera de fonctionner. C'est pourquoi « Ouvrir dans le
navigateur » reste affiché en permanence plutôt que d'apparaître en cas d'échec :
le refus n'est pas détectable à l'avance. Une requête émise par le sidecar reçoit
un 403 même avec l'user-agent exact de la fenêtre, Cloudflare discriminant sur
l'empreinte TLS, hors de portée d'un client qui n'est pas un navigateur.

## Session et reconnexion

La webview a son propre magasin de cookies, dans le répertoire de données de
l'application. Il faut donc s'y connecter une fois ; la session persiste ensuite
entre les lancements.

Sans session, claude.ai renvoie les visiteurs vers sa page marketing
`claude.com/product/design`. La vue le détecte en lisant l'URL atteinte et
affiche un avertissement de reconnexion. La détection est volontairement étroite :
`claude.ai/login` et `accounts.google.com` sont des étapes légitimes du flux de
connexion, et alerter dessus afficherait une erreur en pleine authentification.

## Superposition et fenêtre détachée

Une webview est une surface du système, dessinée au-dessus du DOM. Elle est donc
masquée dès que la palette **Ctrl+K** s'ouvre, sans quoi celle-ci apparaîtrait
derrière elle. Quitter la vue masque la webview sans la détruire : la recréer
rechargerait claude.ai et ferait perdre le travail en cours.

**Détacher dans une fenêtre** ouvre Claude Design dans une fenêtre native
séparée, dont la taille et la position sont mémorisées. C'est le repli si
l'intégration se comporte mal.
