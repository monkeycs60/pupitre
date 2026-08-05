# HANDOFF M3 + M4 — plan d'exécution (rédigé le 2026-08-04, après tag `m2`)

Tu reprends le développement de Pupitre. À lire avant de commencer :
`README.md`, le design `docs/plans/2026-08-04-pupitre-design.md` (surtout §6, §7, §9, §10, §11, §12 — c'est le cahier des charges de M3/M4), et `docs/HANDOFF-M2.md` (section « Décisions déjà tranchées », toujours valable).

## Conventions non négociables (inchangées depuis M1)

- **TDD** ; les fixtures de `sidecar/tests/fixtures/` font foi sur les formats ; fake bins (`sidecar/tests/fake-bins/`) pour tout tester sans quota.
- **Jamais d'API payante** : uniquement les CLIs `claude` et `codex` authentifiés sur abonnement. Les validations réelles coûtent des centimes de quota : les faire une fois, consigner le résultat dans `e2e/basic-flow.md`, ne pas les rejouer en boucle.
- Vérifs avant tout commit : `cd sidecar && bun test && bunx tsc --noEmit` **et** `cd ui && bunx tsc --noEmit && bun run build`.
- Un commit par tâche, message en français, préfixe conventionnel (`feat:`, `fix:`, `docs:`, `test:`).
- **Review milestone à la fin de chaque phase** avec un modèle fort (sol high ou opus high) — jamais un modèle cheap pour juger (même philosophie que le Gardien). Corriger les Critical/Important avant de passer à la phase suivante.
- Port 4820 : toujours `fuser -k 4820/tcp` avant de relancer un sidecar de test (un vieux process a déjà faussé un test M2).
- Tag git `m3` puis `m4` à la fin de chaque milestone, après review finale.

## État au 2026-08-05

- **M4-M terminé et review milestone propre** : Fleet HTTP+WebSocket pour les
  tours, sous-tâches et routines de tous les projets, index FTS5 local avec
  backfill des titres/messages/Débriefs, et palette Ctrl+K pour la navigation,
  les workflows, les skills et les actions de contrôle. La review ciblée a
  rendu la palette visible dans la navigation et isolé l'environnement du test
  Fleet afin d'éviter une fuite de faux binaire vers les suites suivantes.
- **M4-L terminé et review milestone propre** : workflows épinglés par projet,
  scheduler cron interne, conversations taguées routine, historique avec tokens,
  activation et lancement manuel, notifications natives de fin de routine et de
  tâche longue avec seuil réglable. La review ciblée a rendu le lancement manuel
  non bloquant, préservé le planning des routines en pause, clôturé les runs
  orphelins au redémarrage et empêché le replay d'anciennes notifications.
- **M4-K terminé et review milestone propre** : inventaire unifié avec watcher,
  bibliothèque filtrable et favoris projet, invocation `$skill` cross-provider,
  suggestions lexicales (Luna fast uniquement pour une ambiguïté avec panneau
  ouvert) et composer Sol avec installation projet/globale sans écrasement.
  La review ciblée a corrigé les frontmatters YAML multilignes et fermé le
  panneau de suggestions par défaut afin qu'aucun appel Luna ne parte en
  arrière-plan au chargement d'une conversation.
- **Latence Codex diagnostiquée avant M4-K** : six tours Luna récents prenaient
  124–126 s avant le premier retour ; trois probes isolés (fast avec/sans
  orchestration, puis standard) reproduisaient ~122 s. Le mode fast et le
  conductor n'étaient donc pas la cause. Pupitre désactive désormais plugins et
  MCP utilisateur dans son app-server, tout en réactivant explicitement son MCP
  `conductor` par thread. La configuration finale a été vérifiée avec zéro MCP
  utilisateur actif ; aucun nouveau tour réel n'a été consommé après cette
  vérification. `PUPITRE_CODEX_USER_MCPS=1` constitue l'opt-in de compatibilité.
- **Mesures de tour ajoutées à l'UI** : attente avant premier retour, durée en
  cours et total final sont persistés dans les événements et affichés sous
  chaque tour.

- **M3-T0 terminé** : watchdog app-server, écritures atomiques, compaction des
  deltas, sweep SQL, limites média et sidecar Tauri de production.
- **M3-G terminé** : moteur et UI Gardien, décisions ciblées, blocage projet et
  contre-avis cross-provider.
- **M3-H terminé** : Débrief versionné, handoff via Débrief, jauge de contexte et
  questionnement depuis le fil.
- **M3-J terminé** : graphe Git, provenance des commits, diffs bornés, worktrees
  et alertes Gardien par commit.
- **M3-I terminé et review milestone propre** : inventaire structuré, exécution
  des scopes avec sorties et captures inline, acquittement atomique des flags
  liés et rafraîchissement Gardien au niveau projet.
- Vérifications locales : 263 tests sidecar, typechecks sidecar/UI, build Vite et
  `cargo check` verts. Les validations Claude réelles n'ont pas été rejouées faute
  de crédits ; les fake bins et fixtures ont été utilisés conformément au plan.

### Verdict de la review finale (2026-08-05)

Trois passes de review ont été menées sur `m2..39d4d00` (les deux premières sont
détaillées dans `docs/HANDOFF-REVIEW-M3.md`). La dernière passe a couvert le
moteur Gardien, le stockage des conversations et la supervision Tauri, et a
remonté **six constats Critical/Important, tous corrigés et couverts par un test
qui échouait avant correction** :

1. `stores/conversations.ts` — le sweep de redémarrage ne visait que le dernier
   event et non le dernier `status` : un tour coupé en plein streaming laissait
   la conversation `running` à vie, saisie et boutons désactivés, `Annuler` en
   409. **Critical.**
2. `reviews.ts` — le parsing du diff distinguait en-tête et contenu par préfixe :
   un front-matter Markdown ou un commentaire SQL `-- …` décalait l'ancrage, et
   un `-- /chemin/absolu` supprimé faisait échouer la review entière.
   **Critical.**
3. `reviews.ts` — `HEAD` était résolu séparément du diff worktree : la review
   pouvait être archivée sous un commit qu'elle n'avait jamais lu. La capture est
   rejouée tant que `HEAD` bouge, puis échoue explicitement. **Important.**
4. `reviews.ts` — les fichiers non suivis étaient listés *après* le diff des
   fichiers suivis : un `git add` concurrent faisait disparaître un fichier des
   deux sorties, donc du diff soumis au Gardien (faux négatif silencieux).
   L'ordre est inversé. **Important.**
5. `reviews.ts` — `core.quotePath` rendait tout fichier accentué non signalable
   et faisait échouer la review dès qu'un flag le visait. **Important.**
6. `server.ts` — une continuation de passation en cours de nettoyage acceptait
   encore un message, perdu ensuite avec la conversation supprimée.
   `handoff_pending` refuse désormais l'écriture. **Important.**
7. `src-tauri/src/lib.rs` — l'arrêt de l'application pouvait tomber pendant un
   spawn en vol et laisser un sidecar orphelin sur le port 4820 ; le spawn a
   désormais lieu sous le mutex. **Important.**

Dette explicitement reportée à M4 (constats Minor, aucun impact sur la
correction du jalon) : pas de backoff ni de remontée UI quand le spawn du
sidecar échoue en boucle ; sorties stdout/stderr du sidecar jetées, donc panne
peu diagnosticable ; backfills de `db.ts` hors de la transaction de leur
`ALTER TABLE` ; un flag mal ancré fait encore perdre toute la review au lieu de
la seule zone concernée ; `executeCounter` boucle sans plafond sur la limite de
sous-tâches ; `git.ts` ne neutralise pas `core.quotePath` pour la vue Git.

---

# M3 — Contrôle (Gardien, Débrief, Tester, vue Git)

Objectif : donner à Clement les outils pour **garder le contrôle** sur ce que les agents produisent — review des risques, bilan compréhensible, tests guidés, visualisation git.

## Phase T0 — Dette technique M2 (à faire d'abord, elle conditionne la fiabilité de M3)

1. **T0.1 Watchdog d'inactivité app-server** : si le process `codex app-server` ne produit plus rien pendant N minutes hors tour actif, le tuer proprement (il redémarre en lazy au tour suivant). Configurable `PUPITRE_APPSERVER_IDLE_MS`.
2. **T0.2 Transaction sur appendEvent** : l'écriture event + mise à jour conversation doit être atomique (bun:sqlite `transaction()`).
3. **T0.3 Coalescing des text-delta** : en DB uniquement (le streaming WS reste tel quel), fusionner les deltas d'un même tour au moment de la persistance ou en compaction post-tour — objectif : replay plus léger sur les longues conversations.
4. **T0.4 Sweep des runs orphelins en SQL** (une requête UPDATE au boot au lieu de la boucle JS).
5. **T0.5 Limite d'upload media** : taille max par image + total par message, 413 au-delà, test.
6. **T0.6 Câblage prod Tauri** : origin `tauri://localhost` accepté par le check Origin du sidecar, CSP dans tauri.conf.json, spawn du sidecar compilé (`bun build --compile`) en release. Vérifier `bunx tauri build` puis lancement du binaire.

## Phase G — Le Gardien (design §6)

7. **G1 Moteur de review (backend)** :
   - Table `reviews` (id, project_id, conversation_id, git_ref_base, git_ref_head, status, created_at) + table `review_flags` (id, review_id, file, line_start, line_end, severity `red|orange|grey`, category, message, status `open|acked|dismissed|countered`).
   - Déclenchement : bouton « Review Gardien » sur une conversation (POST /api/reviews) ; le sidecar calcule le diff (`git diff base...head` dans le cwd du projet), le découpe en zones (un modèle cheap PEUT servir ici, uniquement pour le pré-découpage), puis envoie chaque zone au modèle de review.
   - **Modèles de scan par défaut : Opus 5 high (claude) / GPT-5.6 Sol high (codex)** — changeables, sauvegardés dans les presets existants (étendre la table presets avec les champs review_provider/review_model/review_effort). Jamais de modèle cheap pour juger.
   - Grille de risques dans le prompt de scan : perte de données, side effects sur modules partagés, changement de contrat d'API, migration/schéma, comportement silencieusement modifié, gestion d'erreur supprimée, secret/credential, absence de test sur code critique.
   - Sortie structurée exigée du modèle (JSON : flags ancrés à des lignes précises, une phrase concrète et actionnable chacun). Le run de review passe par les adapters existants (un tour headless), avec parsing robuste de la sortie.
   - Tests sur fixtures : enregistrer une vraie sortie de scan une fois, la rejouer via fake bin.
8. **G2 UI Gardien** :
   - Onglet « Gardien » par projet : liste des reviews en attente, badge de comptage dans la sidebar.
   - **Diff thermique** : rendu du diff avec les lignes flaggées surlignées rouge/orange/gris, message du flag en marge, dépliable.
   - **Validation ciblée (anti-vibecoding)** : PAS de bouton « Approve » global. L'app extrait 2-4 décisions explicites (générées par le scan) à acquitter une par une (« OK pour que l'endpoint change de format de réponse ? »). Acquittement persisté par flag.
   - **Niveaux de blocage par projet** : réglage projet `gardien_mode` = `informatif` (défaut) | `bloquant` (un flag rouge non acquitté affiche un avertissement bloquant sur le bouton commit/validation — Pupitre ne committe pas lui-même, le blocage est visuel et dans l'API).
9. **G3 Contre-avis cross-provider** :
   - Sur chaque flag (ou « tous les points » d'un coup) : bouton « Contre-avis » → le provider OPPOSÉ à celui qui a écrit le code re-juge le flag (confirme / infirme / nuance), modèle et effort choisissables (défaut : le fort de l'autre provider).
   - Objectif affiché : **certitude**, pas chasse au faux positif. Le verdict s'ajoute au flag (`countered`, avec le texte du contre-avis).
   - Option par projet : contre-avis automatique sur tout flag rouge.
   - Réutilise le moteur de subtasks (D1) pour lancer les contre-avis en parallèle.
10. **Review milestone phase G** + fixes.

## Phase H — Le Débrief « Reprendre le contrôle » (design §7)

11. **H1 Génération de débrief (backend + UI)** :
    - Bouton « Reprendre le contrôle » dans le composer → POST /api/conversations/:id/debrief.
    - Le sidecar génère un bilan structuré **depuis le dernier débrief** (ou depuis le début) via le modèle de la conversation : ce qui a été construit (langage humain), décisions prises et pourquoi (+ alternatives écartées), implications, ce qui reste ouvert.
    - Table `debriefs` (id, conversation_id, event_id_from, event_id_to, content_md, created_at). Épinglé en accordéon dans le fil (nouvel AppEvent `debrief-ref` ou rendu dédié), versionné — la série des débriefs raconte l'histoire.
12. **H2 Intégrations du débrief** :
    - **Remplacer le résumé fixe du handoff cross-provider (E2) par un vrai débrief** : le switch cross-provider génère un débrief, l'épingle, et seed la nouvelle conversation avec.
    - **Jauge de contexte** : afficher le remplissage estimé du contexte de la conversation (somme des usages connus vs fenêtre du modèle) dans la barre de la conversation ; à l'approche de la saturation, suggérer un handoff-débrief (pas d'auto-compact surprise).
    - Mode « explique-moi comme à un collègue » : possibilité de poser des questions sur un débrief (nouveau tour seedé avec le débrief + consigne de citer le moment de la conversation) — v1 simple : bouton « Questionner ce débrief » qui pré-remplit le composer.
13. **Review milestone phase H** + fixes.

## Phase J — Vue Git (design §10)

14. **J1 Onglet Git par projet** :
    - Graphe visuel des branches (lecture via `git log --graph`-équivalent parsé côté sidecar : GET /api/projects/:id/git), commits, branches, HEAD.
    - **Commits tagués par conversation d'origine** : à chaque tour qui committe (détection : le HEAD du projet a bougé pendant le tour), enregistrer le lien commit ↔ conversation (table `commit_links`). Best effort, pas bloquant.
    - Diff entre deux branches/refs en un clic (rendu réutilisant le composant diff du Gardien).
    - Les flags du Gardien restent visibles sur les commits concernés (jointure reviews ↔ refs).
    - Worktrees listés s'il y en a.
15. **Review milestone phase J** (peut être fusionnée avec celle de H si les deux sont petites) + fixes.

## Phase I — Le bouton « Tester » (design §11)

16. **I1 Inventaire + scope** :
    - Bouton « Tester » → un tour spécial : le modèle relit la conversation et produit un **inventaire structuré** de ce qui a été implémenté et est testable.
    - Si plusieurs items : l'UI affiche le choix du scope avec pistes concrètes par item (test unitaire, parcours navigateur, étapes manuelles guidées) ; Clement choisit.
17. **I2 Exécution avec preuves** :
    - Le scope choisi part en exécution (tour normal ou subtask) : sorties de tests, screenshots si parcours navigateur, verdict par scope — tout inline dans le fil (les previews d'images existent déjà).
    - **Boucle avec le Gardien** : un flag « absence de test sur code critique » alimente les suggestions de scope ; un scope testé avec succès marque le flag `acked` automatiquement.
18. **Review milestone phase I** + fixes.

## Clôture M3

19. **E2E M3** : étendre `e2e/basic-flow.md` — review Gardien sur un vrai diff (fixture ou réel ~2 centimes), acquittement ciblé, contre-avis, débrief généré + handoff via débrief, vue Git, bouton Tester sur un cas simple.
20. **Review finale M3** (diff complet depuis `m2`) + fixes + **tag `m3`**.
21. Mettre à jour `README.md` et ce document (section « État ») au fil de l'eau.

---

# M4 — Confort (skills, workflows, routines, fleet, recherche, aide)

Objectif : faire de Pupitre le cockpit quotidien — découverte des skills, automatisation, navigation rapide.

## Phase K — Bibliothèque de skills & suggestions (design §9)

1. **K1 Inventaire unifié** :
   - Scanner + watcher (fs.watch) : `~/.claude/skills`, skills des plugins Claude Code, `.claude/skills/` de chaque projet, `~/.codex/prompts`, `AGENTS.md`. Index en DB : nom, description, triggers, provenance, chemin.
   - Vue « Bibliothèque » (entrée sidebar) : recherche, filtres provider/projet, aperçu du SKILL.md, favoris par projet.
2. **K2 Pont cross-provider** :
   - Skills Claude injectés dans les runs Codex : v1 = injection du contenu du SKILL.md seul dans le prompt (le design assume cette limite — les skills avec scripts/références perdront en route, c'est accepté). Prompts Codex invocables depuis Claude de la même façon.
3. **K3 Panneau latéral de suggestions** (le SEUL panneau latéral de l'app) :
   - Matcher léger sur le message en cours de frappe / le dernier tour : v1 = matching lexical sur descriptions + triggers (pas d'embeddings tant que ce n'est pas nécessaire) ; appel gpt-5.6-luna fast uniquement pour les cas ambigus, et seulement si le panneau est ouvert.
   - 2-3 suggestions max, bouton « Lancer » qui pré-remplit le composer avec l'invocation du skill. Repliable, état persisté.
4. **K4 Composer de skills** : « Nouveau skill » → description du besoin → un tour orchestrateur rédige le SKILL.md (via le skill `skill-creator` s'il est présent, sinon un prompt maison) et l'installe dans la source choisie (projet ou global).
5. **Review milestone phase K** + fixes.

## Phase L — Workflows épinglés & routines (design §12)

6. **L1 Workflows épinglés par projet** : un workflow = skill + prompt pré-rempli + modèle/preset. Table `workflows`, affichés sous le nom du projet dans la sidebar, one-click → nouvelle conversation pré-lancée. CRUD simple dans l'UI.
7. **L2 Routines (cron)** : table `routines` (schedule cron, workflow_id ou prompt, enabled) ; scheduler dans le sidecar (setInterval + calcul du prochain run, PAS de dépendance cron système) ; chaque run = une conversation normale taguée routine. Vue « Routines » : liste, historique des runs, sorties, coût (tokens), toggle enable.
   - **Notification native en fin de run de routine et de tâche longue** (> seuil configurable) — étendre le canal de notifs des quotas (M2-C2).
8. **Review milestone phase L** + fixes.

## Phase M — Fleet view, recherche globale, palette (design §10)

9. **M1 Fleet view** : grille de tout ce qui tourne (tours actifs, subtasks, routines en cours), tous projets confondus — statut, durée, dernier événement, bouton « rejoindre la conversation ». Les données existent (runs actifs du runner + subtasks) : GET /api/fleet + WS.
10. **M2 Recherche globale** : SQLite FTS5 sur le texte des events (messages user + text-final), débriefs, titres de conversations. Index rempli au fil de l'eau + backfill au boot. GET /api/search.
11. **M3 Palette Ctrl+K** : navigation (projets, conversations), lancement de workflows/skills, actions Tester/Débrief/Review au clavier. Se nourrit de la recherche globale.
12. **Review milestone phase M** + fixes.

## Phase N — Divers confort (design §8, §10, §12)

13. **N1 Coûts par conversation** : tokens par conversation, répartition par modèle, « **économie de délégation** » (ce que les subtasks Luna auraient coûté en tokens du modèle parent — comparaison en tokens, pas en euros). Vue mensuelle par projet. Les données d'usage sont déjà persistées (events `usage`).
14. **N2 Explorateur de mémoire** : vue sur `~/.claude/memory/` — lire, éditer, supprimer les fichiers memory (avec confirmation). Simple éditeur markdown.
15. **N3 Handoff terminal ⇄ app** : bouton « Copier la commande de reprise » (`claude --resume <cli_session_id>` / `codex resume <thread_id>`) sur chaque conversation. La détection inverse (sessions lancées au terminal reprises dans l'UI) est un spike : regarder `~/.claude/projects/*/` et `~/.codex/sessions/` ; si les formats sont stables, lister ces sessions dans l'UI avec « importer » ; sinon documenter et reporter.
16. **N4 Aide intégrée** (design §10 — demande explicite : les concepts maison doivent s'expliquer eux-mêmes) :
    - Onglet « Aide » : pages markdown dans `docs/help/` (une par concept : Gardien, Débrief, Tester, presets, quotas, orchestration, skills, routines), rendues dans l'app, searchables. À rédiger au fil des phases, pas à la fin.
    - **Tooltips systématiques** sur tout bouton/badge non évident : une phrase qui dit ce que ça fait ET pourquoi, lien « en savoir plus » vers la page d'aide.
    - **Empty states explicatifs** : chaque écran vide (aucune review, aucune routine, aucun skill) explique ce que la feature fera.
17. **Review milestone phase N** + fixes.

## Clôture M4

18. **E2E M4** : étendre `e2e/basic-flow.md` — bibliothèque + suggestion + lancement d'un skill, workflow épinglé, routine exécutée (schedule court en test), fleet view pendant un run, recherche + palette, aide.
19. **Passe design UI finale** sur les nouveaux écrans (cohérence avec la refonte F2 — réutiliser les mêmes tokens/styles, screenshots avant/après).
20. **Review finale M4** (diff depuis `m3`) + fixes + **tag `m4`**.

---

## Ordre global et jalons

| Jalon | Contenu | Taille estimée |
|---|---|---|
| M3-T0 | Dette technique (6 petites tâches) | S |
| M3-G | Gardien complet (moteur, UI thermique, validation ciblée, contre-avis) | **L — le plus gros morceau des deux milestones** |
| M3-H | Débrief + intégration handoff + jauge de contexte | M |
| M3-J | Vue Git | M |
| M3-I | Bouton Tester | M |
| tag m3 | e2e + review finale | S |
| M4-K | Skills (inventaire, pont, suggestions, composer) | L |
| M4-L | Workflows + routines + notifs | M |
| M4-M | Fleet + recherche + Ctrl+K | M |
| M4-N | Coûts, mémoire, handoff terminal, aide | M |
| tag m4 | e2e + passe design + review finale | S |

## Décisions déjà tranchées (ne pas rouvrir — s'ajoutent à celles de HANDOFF-M2)

- Modèles de review Gardien par défaut : **Opus 5 high / GPT-5.6 Sol 5.6 high**, changeables à la volée, sauvegardés en preset. Cheap uniquement pour le pré-découpage du diff, jamais pour juger.
- Pas de bouton « Approve » global au Gardien : validation ciblée point par point uniquement.
- Contre-avis = provider opposé à celui qui a écrit le code ; objectif certitude.
- Le handoff cross-provider utilise le Débrief (H2 remplace le résumé fixe de E2).
- Pas d'auto-compact : jauge de contexte + suggestion de handoff, c'est l'utilisateur qui décide.
- Panneau latéral de suggestions de skills = le seul panneau latéral. Tout le reste vit inline dans le fil.
- Pont skills→codex v1 = SKILL.md seul (perte acceptée sur les skills à scripts).
- Suggestions de skills v1 = matching lexical, Luna fast seulement pour l'ambigu.
- Routines = scheduler interne au sidecar, pas de cron système.
- Coûts affichés en tokens (jamais d'invention de prix en euros).
- Hors périmètre confirmé : vocal, panneau navigateur dédié.

## Risques identifiés (design §17, toujours ouverts)

- Sortie structurée des modèles de review : prévoir un parsing tolérant + retry avec consigne de format si le JSON est invalide.
- Fidélité de la conversion skills → Codex sur les skills complexes (accepté en v1).
- Détection des sessions terminal (N3) : formats internes des CLIs non garantis — c'est un spike, pas un engagement.
- Volume des events sur les longues conversations : T0.3 (coalescing) doit passer avant la recherche FTS (M4-M2) pour ne pas indexer des miettes.
