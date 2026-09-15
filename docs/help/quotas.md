# Quotas

Pupitre lit les limites publiées par Claude Code, Codex CLI, Grok Build et
l'abonnement OpenCode Go (exécuté par le CLI `reasonix`). Les jauges sont des
signaux : elles ne changent jamais automatiquement le modèle choisi.

Les providers ne publient pas la même chose, et la barre de quotas le dit
plutôt que de le masquer :

- **Codex** publie un pourcentage d'usage par fenêtre. La jauge est
  remplie.
- **Grok** publie le pourcentage du pool hebdomadaire partagé (grok.com /
  SuperGrok), relevé gratuitement via le jeton de `grok login`.
- **OpenCode Go** publie un pourcentage par fenêtre — 5 h, hebdomadaire,
  mensuelle — sur `https://opencode.ai/zen/go/v1/usage`, avec la clé
  `OPENCODE_API_KEY`. Sans clé, la barre le dit au lieu d'afficher zéro.
- **Claude** ne publie qu'une **date de remise à zéro**, jamais un pourcentage.
  La barre affiche donc « reset dans 4 h » sans jauge. Ce n'est pas une panne :
  la donnée n'existe pas côté CLI.

Codex, Grok et OpenCode Go répondent à une lecture d'état gratuite, que
Pupitre fait au démarrage. Claude, lui, n'expose son quota que **pendant un
tour** : Pupitre lance donc au lancement une sonde minimale sur le modèle le
moins cher, et seulement si le relevé stocké ne couvre plus la fenêtre en
cours. Le bouton **Actualiser** force une relève ; côté Claude, elle consomme
ce même tour minimal.

L'abonnement OpenCode Go s'affiche sous le nom « OpenCode Go (Reasonix) », et
« OpenCode Go » seul là où la place manque (la barre compacte). Le CLI
`reasonix` reste le binaire lancé : il n'est nommé que pour dire qui exécute le
tour.

Les alertes natives peuvent signaler la dernière heure d'une fenêtre ou un
seuil d'usage. Une donnée absente est nommée, jamais devinée.
