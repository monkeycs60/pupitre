# Gardien en calque sur la vue Git — design validé

Date : 2026-08-08 · Statut : validé (brainstorm Clément × Claude) · Remplace le parcours Gardien actuel (vue dédiée + décisions à acquitter).

## 1. Intention

Le Gardien actuel juge et demande validation : des « décisions » formulées en questions, un acquittement par carte, un mode bloquant déclaratif. L'intention d'origine du produit est inverse : **reprendre le contrôle en voyant le code**. La refonte change le modèle mental — *le Gardien surligne, l'utilisateur dirige* — et supprime tout ce qui relève de la conformité.

Constats du parcours actuel qui motivent la refonte :

- l'entrée est un modal technique (providers, refs `CONVERSATION`/`WORKTREE`) pour un geste qui devrait être un clic ;
- le CTA « Relire les changements actuels » de la vue Gardien ne fait rien sans conversation ouverte, sans feedback ;
- pendant un scan : aucune progression, absent de Fleet, UI qui peut se figer (poll 1 s) ;
- les résultats sont des questions à parser, cliquer une carte ne mène pas à la zone, les actions sont hors écran ;
- le mode bloquant ne bloque techniquement rien (« validation bloquée visuellement ») ;
- le badge de reviews du rail n'est jamais alimenté ; les décisions n'existent que si > 4 flags.

## 2. Architecture d'information

La vue **Git devient l'unique lieu de lecture de code**, avec trois modes de diff : worktree (défaut à l'ouverture), commit isolé, comparaison base→cible. Le Gardien est un **calque** : quand des annotations existent pour le diff affiché, elles se superposent. Un toggle 🛡 dans l'en-tête masque le calque pour lire le diff nu.

Disparaissent : la vue Gardien du rail, le sélecteur Informatif/Bloquant, le bandeau « validation bloquée », la liste de décisions, le regroupement `> 4 flags`. Le badge du bouclier est remplacé par un **badge sur l'icône Git** : points rouges/orange ouverts sur le worktree du projet courant.

La vue Git gagne une **arborescence des fichiers modifiés** en colonne gauche : pastilles de sévérité par fichier, clic = diff de ce fichier seul, entrée « Tous les fichiers » pour la vue continue. Branches, commits, worktrees, liens commit→conversation restent au-dessus, inchangés.

Les entrées conversationnelles sont conservées mais redirigées : le bouton « Review Gardien » de l'en-tête de conversation et l'action de la palette lancent le scan **et ouvrent la vue Git** sur le résultat.

## 3. La zone actionnable

Une **zone** = un flag ancré `fichier:ligne-ligne` sur des lignes réellement modifiées (validation stricte conservée). Dans le diff : lignes teintées rouge/orange/gris, titre court en marge. Cliquer la zone la sélectionne, scrolle si besoin, et déplie une **carte ancrée sous le hunk** :

- **Constat complet** + badge sévérité + badge « manque de test » si `test_gap`.
- **Envoyer un agent** — champ pré-rempli avec le constat, éditable (« réutilise le composant X »), Envoyer → sous-tâche **écriture** rattachée à la conversation d'origine (via `commit_links`, sinon la conversation ouverte, sinon choix). Progression inline (réutilisation de `SubtaskCard`), lien vers le fil.
- **Contre-avis** — inchangé (provider opposé, verdict confirmé/nuancé/infirmé attaché à la zone). `auto_counter_red` est conservé.
- **OK, vu** → `treated` ; **Ignorer** → `ignored` (faux positifs).

**États** : `open` → (`agent_running`) → `treated` / `ignored` / `resolved`. Fin de sous-tâche → zone « à re-vérifier » ; le rescan incrémental suivant ferme en `resolved` si le hunk a changé et que le modèle ne re-signale rien. L'acquittement automatique par test réussi (`test-scope-result`) est conservé pour les zones `test_gap`.

En tête d'arborescence : compteurs-filtres Rouge / Orange / Traitées, et **« Traiter les N ouverts »** → une sous-tâche par zone, batché par 4 (`MAX_CONCURRENT_SUBTASKS`), avec confirmation.

## 4. Le scan

**Manuel** : bouton **« Relire ce diff »** dans l'en-tête Git, actif sur tout diff affiché. Zéro modal : config issue du preset par défaut du projet (`defaultReviewConfig`) ; un ⚙ replié porte les dérogations ponctuelles (l'ancien contenu du modal). Les refs disparaissent de l'UI : la base est déduite du diff affiché.

**Incrémental** : chaque zone mémorise un **hash de son hunk**. Au scan suivant, seuls les hunks nouveaux/modifiés repartent au modèle ; une zone au hunk intact conserve son état. Rend viable le **mode auto**, opt-in par projet (« Rescanner après chaque tour ») : déclenché au statut terminal d'un tour ayant modifié des fichiers, jamais deux scans en vol, délai minimal entre deux.

**Feedback** : progression « zone 2/5 » (le découpage déterministe donne le total dès le départ), pastilles fichiers « en cours », scan visible **dans Fleet**. Fin de scan : notification native si nouveaux rouges, rafraîchissement du quota du provider de review (bug constaté : Codex encore à 0 % après une review), mise à jour du badge Git. Le poll 1 s est remplacé par un push WS (canal fleet/review) — corrige aussi le gel d'UI observé pendant un scan.

## 5. Données, API, suppressions

**DB**
- `review_flags` : `status` étendu (`open`/`agent_running`/`treated`/`ignored`/`resolved` ; migration `acked`→`treated`, `dismissed`→`ignored`) + `hunk_hash`, `subtask_id`, `user_message`.
- `review_decisions` : **supprimée** (drop ; les flags portent tout).
- `projects.gardien_mode` : supprimé. `auto_counter_red` : conservé, déplacé dans les réglages projet.
- `reviews` : + `scope` (worktree/commit/range), + `parent_review_id` (chaîne incrémentale).

**API**
- Nouveau : `POST /api/review-flags/:id/dispatch` (message + sous-tâche écriture), `POST /api/reviews/:id/dispatch-all`.
- `PATCH /api/review-flags/:id` : nouveaux statuts.
- Supprimé : `PATCH /api/review-decisions/:id`, `extractDecisions` + `decisionPrompt` dans `reviews.ts` (un appel modèle de moins par review).
- `gardien-status` → `review-status` : zones ouvertes par sévérité, poussé en WS.

**UI**
- Supprimés : `GuardianView.tsx` + `guardian.css`.
- `GitView` : arborescence de fichiers + `DiffViewer` étendu (cartes ancrées, actions, scroll-to).
- `ReviewDialog` : rétrogradé en panneau ⚙ replié.
- Rail : badge sur l'icône Git, alimenté par le push `review-status`.

## 6. Tests

- `reviews.test.ts` : retirer les décisions ; ajouter hash de hunk, statuts, dispatch.
- Nouveaux : scan incrémental (hunk intact → état conservé ; hunk modifié → rescanné), dispatch → sous-tâche écriture rattachée à la bonne conversation, fermeture auto en `resolved` par rescan, `dispatch-all` batché par 4.
- `ui-review-diff.test.ts` : cartes ancrées, filtres, arborescence.
- e2e : réécrire `pupitre-m3-gardien` sur le parcours Git (scan 1 clic → zone → dispatch → rescan).

## 7. Hors périmètre (notés pendant le brainstorm, non inclus ici)

- Vue « À traiter » transverse (reviews + tests + routines + sous-tâches) — reco n°1 de l'audit du 2026-08-06.
- Réalignement de la gamification (récompenser les bons gestes plutôt que les tokens consommés).
- Handoff automatique à saturation de contexte.
- Persistance du projet/vue sélectionnés au rechargement.
