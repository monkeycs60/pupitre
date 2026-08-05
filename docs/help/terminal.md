# Reprise terminal

Après l'ouverture d'une session CLI, **Reprendre au terminal** copie la commande
adaptée au provider : `claude --resume <id>` ou `codex resume <id>`. La commande
reprend la session authentifiée existante ; elle ne crée aucun appel API séparé.

L'import automatique de sessions lancées hors Pupitre est reporté. Les formats
de fichiers Codex présents sur une même machine couvrent plusieurs schémas
incompatibles ; une liste partielle serait plus trompeuse qu'utile.
