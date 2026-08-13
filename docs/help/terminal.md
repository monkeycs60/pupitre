# Reprise terminal

Après l'ouverture d'une session CLI, **Reprendre au terminal** copie la commande
adaptée au provider : `claude --resume <id>` ou `codex resume <id>`. La commande
reprend la session authentifiée existante ; elle ne crée aucun appel API séparé.

L'import automatique de sessions lancées hors Pupitre est reporté. Les formats
de fichiers Codex présents sur une même machine couvrent plusieurs schémas
incompatibles ; une liste partielle serait plus trompeuse qu'utile.

## Recharger et redémarrer

`Ctrl+R` recharge seulement l’interface. `Ctrl+Maj+R` redémarre le sidecar
supervisé, attend qu’il réponde de nouveau, puis recharge l’interface. Sur macOS,
utilisez `Cmd+Maj+R`.

Une modification du code Rust sous `src-tauri/` exige toujours de relancer
`bunx tauri dev` depuis le terminal : le raccourci ne remplace pas le processus
natif qui l’héberge.
