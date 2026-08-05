# Spike N3 — importer les sessions terminal dans Pupitre

Date : 2026-08-05. Verdict : **reporté** ; la reprise app → terminal est livrée,
la détection terminal → app ne l'est pas.

## Sources inspectées

### Claude Code

`~/.claude/projects/<projet>/sessions-index.json` expose actuellement un format
versionné (`version: 1`) avec `sessionId`, `projectPath`, `summary`, `created`,
`modified` et `isSidechain`. Des projets plus anciens n'ont toutefois pas cet
index et leurs JSONL commencent par des événements de formes différentes
(`last-prompt`, `queue-operation`, etc.). L'id reste récupérable depuis le nom de
fichier, mais le titre et le projet ne disposent pas toujours d'une source
uniforme.

### Codex

`~/.codex/sessions/<année>/<mois>/<jour>/rollout-*.jsonl` a connu au moins deux
schémas incompatibles dans les fichiers présents sur la machine :

- ancien format avec `{id, timestamp, instructions, git}` à la racine ;
- format courant `session_meta.payload`, où l'identifiant peut être dans `id`
  et/ou `session_id`, avec `cwd`, `originator` et `cli_version`.

Le format courant contient assez d'information pour une heuristique, mais il
n'est pas un contrat public et l'historique local démontre qu'il évolue.

## Décision

Ne pas présenter une liste « importable » partielle qui oublierait silencieusement
des sessions ou les rattacherait au mauvais projet. Une future implémentation
devra introduire des parsers versionnés par provider, afficher la provenance et
exiger une confirmation du projet avant import. Elle devra aussi exclure les
sessions dont `originator` est Pupitre pour éviter les doublons.

La direction inverse ne dépend d'aucun format disque : Pupitre possède déjà le
`cli_session_id` normalisé. Le bouton **Reprendre au terminal** copie donc
`claude --resume <id>` ou `codex resume <id>` selon le provider.
