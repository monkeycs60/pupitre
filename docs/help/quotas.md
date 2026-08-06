# Quotas

Pupitre lit les limites publiées par Claude Code et Codex CLI. Les jauges sont
des signaux : elles ne changent jamais automatiquement le modèle choisi.

Les deux providers ne publient pas la même chose, et la barre de quotas le dit
plutôt que de le masquer :

- **Codex** publie un pourcentage d'usage par fenêtre. La jauge est remplie.
- **Claude** ne publie qu'une **date de remise à zéro**, jamais un pourcentage.
  La barre affiche donc « reset dans 4 h » sans jauge. Ce n'est pas une panne :
  la donnée n'existe pas côté CLI.

Codex répond à une lecture d'état gratuite, que Pupitre fait au démarrage.
Claude, lui, n'expose son quota que **pendant un tour** : Pupitre lance donc au
lancement une sonde minimale sur le modèle le moins cher, et seulement si le
relevé stocké ne couvre plus la fenêtre en cours. Le bouton **Actualiser**
force une relève ; côté Claude, elle consomme ce même tour minimal.

Les alertes natives peuvent signaler la dernière heure d'une fenêtre ou un
seuil d'usage. Une donnée absente est nommée, jamais devinée.
