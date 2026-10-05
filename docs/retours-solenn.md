# Retours de Solenn

Retours d'usage de Pupitre, observés sur un Mac (Apple Silicon, macOS 15)
avec Claude Opus 5.5 en effort `medium`. Chaque retour donne le symptôme, la
cause mesurée et une piste de correction.

---

## 1. « Recherche dans les fichiers » reste affiché pendant des minutes

### Symptôme

Pendant certains tours, l'étiquette de l'outil reste sur « Recherche dans les
fichiers » plusieurs minutes. On croit Pupitre bloqué, et on finit par annuler
le tour.

### Cause

`shellPresentation` (`ui/src/toolPresentation.ts:45`) choisit l'étiquette en
cherchant `rg|grep|find|fd` **n'importe où** dans la commande. Claude enchaîne
souvent plusieurs étapes dans une seule commande Bash et termine par un `grep`
pour filtrer le résultat. L'étiquette décrit alors cette dernière étape, qui
dure moins d'une seconde, au lieu de l'étape longue.

Cas réels relevés dans `pupitre.db` (événements `tool-start` / `tool-end`) :

| Commande (abrégée) | Étiquette affichée | Durée réelle |
|---|---|---|
| `rm -f … ; ln -sf … ; Rscript run_all.R > log ; grep … log` | Recherche dans les fichiers | 577 s |
| `cd pipeline && Rscript run_all.R > log ; grep -n -A12 … log` | Recherche dans les fichiers | 522 s |
| `cp … ; rm -rf … ; Rscript run_all.R > log ; grep … log \| head` | Recherche dans les fichiers | annulé après ~5 min, sans `tool-end` |
| `rm -rf … ; Rscript run_all.R > log ; grep … log` | Recherche dans les fichiers | annulé après ~3 min, sans `tool-end` |

Les vraies recherches (`grep`, `rg`, outils `Grep` / `Glob`) se terminent en
moins d'une seconde dans le même historique. Pupitre n'était donc pas bloqué :
c'est un pipeline R de 9 à 10 minutes qui tournait. Les deux annulations ont
interrompu ce pipeline.

### Pistes

1. **Afficher la `description` fournie par Claude.** L'outil Bash de Claude
   Code reçoit un champ `input.description` (« Relance le pipeline complet… »).
   Il décrit l'intention de la commande entière et fait une meilleure étiquette
   que l'heuristique. L'heuristique resterait la solution de repli quand le
   champ est absent (Codex, par exemple).
2. **Sinon, classer la commande sur sa première étape longue.** Découper sur
   `;`, `&&`, `||` et `|`, puis ignorer les étapes de filtrage finales
   (`grep`, `head`, `tail`, `echo`) avant d'appliquer les expressions
   régulières. Un `Rscript`, `python`, `node`, etc. donnerait « Exécution d'un
   script ».
3. **Afficher un chrono sur l'outil en cours** (« depuis 3 min »). Il montre
   que quelque chose tourne et aide à décider d'attendre ou d'annuler.
4. **Option : montrer les dernières lignes de sortie** quand la commande les
   envoie dans un fichier de log, pour suivre la progression d'un long script.

---

## 2. Les réponses semblent plus lentes que dans le terminal

### Symptôme

À demande égale, Claude paraît plus lent dans Pupitre que dans un terminal
`claude` ouvert à côté.

### Ce qui a été vérifié

- **Modèle et effort identiques** : Opus 5.5 en `medium` des deux côtés
  (`conversations.effort` et `~/.claude/settings.json`). Cette piste est
  écartée.
- **Démarrage du process** : `ClaudeSession` garde un process par conversation,
  mais le tue après 5 min d'inactivité (`DEFAULT_IDLE_MS`,
  `sidecar/src/adapters/claude-session.ts:19`). Le message suivant repaie le
  démarrage du CLI, de toute la flotte MCP de l'utilisateur et des hooks
  `SessionStart`. Mesure locale : `system/init` arrive après 2,9 s avec la
  config MCP habituelle, contre 0,9 s avec une config vide. Les événements
  `turn-timing` montrent 4 à 7,5 s avant la première réponse.
- **Préambule de format** (`sidecar/src/response-format.ts`) : la demande de
  blocs TODO / FOLLOW-UP et de document HTML allonge les réponses, donc leur
  durée d'écriture. Chez Solenn, son `CLAUDE.md` global demande déjà la même
  chose, si bien que la consigne apparaît en double.
- **Bruit du service** : deux appels identiques à Haiku (« réponds juste ok »)
  ont pris 6 s et 34 s. Une comparaison au ressenti sur quelques messages n'est
  donc pas fiable.

### Pistes

1. Allonger `DEFAULT_IDLE_MS` (par exemple à 30 min) ou le rendre réglable dans
   l'interface.
2. Préchauffer le process `claude` dès l'ouverture d'une conversation, avant
   le premier message.
3. Afficher le temps avant le premier mot (déjà mesuré par `turn-timing`) pour
   distinguer le démarrage du temps de réponse du modèle.
