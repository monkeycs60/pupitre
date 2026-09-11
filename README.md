# Pupitre

Mission control bureau pour Linux : une app qui pilote **Claude Code**, **Codex CLI** et **Grok Build** sur tes abonnements (jamais d'API payante), avec discussions par projet, contrôle des changements, tests guidés et historique Git. Le pupitre du chef d'orchestre : l'app dirige les CLIs sans jouer une note elle-même.

## Architecture (M4)

```
┌─────────────────────────────────────────────┐
│  Tauri 2 (Rust minimal)                     │
│  fenêtre native, spawn du sidecar en dev    │
├─────────────────────────────────────────────┤
│  Sidecar Bun/TypeScript (le cerveau)        │
│  stores SQLite · adapters claude/codex/grok │
│  conversations · subtasks · reviews · skills│
│  serveur HTTP+WS · Git · tests · media       │
├─────────────────────────────────────────────┤
│  Frontend React + Vite (webview)            │
│  chat · Gardien · Résumé · Handoff · Tester │
│  bibliothèque · suggestions · lightbox       │
└─────────────────────────────────────────────┘
```

## Retours visuels Chrome

Une extension Chrome locale permet de pointer des zones sur les interfaces `localhost`, de regrouper les annotations par projet, de choisir une branche et d'envoyer la correction dans une conversation Pupitre. L'installation et l'appairage sont décrits dans [l'aide dédiée](docs/help/retours-visuels.md).

Les CLIs sont normalisés en un schéma d'événements unifié (`sidecar/src/events.ts`) ; le frontend ne connaît jamais Claude, Codex ou Grok directement. Les sessions sont celles des vrais CLIs (`claude -r`, `codex exec resume`, `grok --resume`) : reprise gratuite, et tes skills/CLAUDE.md/AGENTS.md marchent tels quels. Grok lit aussi `~/.grok/skills` et les skills Claude par compatibilité.

## Contrôle des changements (M3)

- **Gardien** analyse le diff Git avec un modèle fort et ancre ses signalements
  sur les lignes concernées, inline dans l'onglet Changements. Il surligne,
  l'utilisateur dirige : par signalement, envoyer un agent avec une consigne,
  marquer vu ou ignorer. Une fois toutes les corrections en cours terminées,
  la relecture repart automatiquement, en incrémental.
- **Résumé session** produit un bilan court des fonctionnalités et correctifs
  implémentés, avec les éléments restant explicitement à terminer. Le **Handoff**
  conserve le débrief complet pour transférer le travail à une nouvelle session.
- **Git** affiche branches, commits, HEAD et worktrees, relie les commits à leur
  conversation d'origine ; Historique des commits avec review par commit.
- **Tester** relit le fil, propose des scopes et méthodes concrètes, puis exécute
  le choix en sous-tâche. Sorties bornées tête/fin, captures navigateur, preuves
  et verdict restent inline ; un succès acquitte atomiquement les alertes
  « absence de test » liées et rafraîchit Gardien dans tout le projet.

Les opérations longues d'une conversation partagent un verrou explicite. Au
redémarrage, les reviews, sous-tâches et scopes interrompus sont clôturés, et une
continuation de passation restée incomplète est retirée plutôt que laissée dans
la sidebar. Exception contrôlée : pendant un tour Codex ou Claude, le composeur
reste ouvert et les précisions — captures comprises — sont injectées dans le tour
actif, puis conservées comme telles dans l'historique. Codex utilise
`turn/steer` ; Claude reçoit des messages `stream-json` sur son entrée persistante
et lit les captures depuis leur chemin local. Un tour Grok est one-shot
(`grok -p`) : le composeur se bloque jusqu'à la fin, comme `codex exec`.

## Bibliothèque de skills (M4-K)

- La vue **Bibliothèque** indexe et surveille les skills Claude globaux et de
  plugins, les skills `.claude/skills` des projets, les prompts Codex et les
  fichiers `AGENTS.md`. La recherche porte sur le nom, la description et les
  déclencheurs ; les favoris sont propres à chaque projet.
- Une invocation `$nom-du-skill` fonctionne dans les deux providers. Pupitre
  injecte le `SKILL.md` demandé dans le tour tout en conservant le message
  original dans l'historique. Le pont v1 ne transporte volontairement ni les
  scripts, ni les références, ni les assets du skill.
- Le seul panneau latéral de l'app propose jusqu'à trois skills par matching
  lexical sur le brouillon ou le dernier message. Il est fermé par défaut et
  mémorise le choix de l'utilisateur. Luna fast n'intervient que pour départager
  des scores proches lorsque le panneau est ouvert.
- **Nouveau skill** demande un besoin et une portée projet/globale. Codex Sol
  rédige le fichier avec le `skill-creator` indexé s'il existe ; l'installation
  refuse d'écraser un `SKILL.md` existant et rafraîchit immédiatement l'index.

## Workflows et routines (M4-L)

- Un workflow épinglé associe un skill, un prompt et un preset ou modèle. Il
  apparaît sous son projet dans la sidebar et démarre une nouvelle conversation
  en un clic ; son CRUD reste accessible par **+ Workflow**.
- La vue globale **Routines** planifie un workflow ou un prompt libre avec une
  expression cron cinq champs, calculée par le sidecar sans dépendance au cron
  système. Chaque passage devient une conversation normale marquée routine.
- L'historique affiche état, durée, tokens et accès à la sortie. Une exécution
  manuelle démarre en arrière-plan sans décaler le prochain passage planifié.
- Une notification native signale la fin des routines et des tâches
  interactives longues. Leur seuil est réglable dans la vue Routines (120 s par
  défaut), et la permission n'est demandée qu'au premier événement réel.

## Fleet, recherche et palette (M4-M)

- **Fleet** agrège en temps réel les tours, sous-tâches et routines actifs sur
  tous les projets. Chaque cellule expose durée, modèle et dernier événement,
  avec un accès direct à la conversation concernée.
- La recherche globale repose sur un index SQLite FTS5 local : titres de fils,
  messages utilisateur, réponses finales et Débriefs sont indexés au fil de
  l'eau, avec reconstruction de l'historique au démarrage. Aucune donnée ne
  quitte la machine pour rechercher.
- **Ctrl+K** ouvre la palette depuis n'importe quel écran. Elle navigue vers les
  projets et conversations, interroge la recherche globale, lance workflows et
  skills, ouvre Fleet/Routines/Bibliothèque et déclenche Tester, Résumé session ou
  Gardien sur le fil courant.

## Tableau de bord (tranche A)

- Le **Tableau de bord** ajoute une vue projet centrée sur le **ticket** :
  une ligne relie la tâche, sa branche, sa MR, son pipeline, son éventuel
  déploiement, ses conversations Pupitre et ses notes locales.
- Les données viennent de **ClickUp** et **GitLab**. La relève reste
  déterministe, sans LLM, avec rafraîchissement automatique quand Pupitre est
  actif, relance manuelle possible et diffusion temps réel vers l'UI.
- Côté GitLab, Pupitre réutilise le token de **`glab`** quand il existe ; un
  token dédié peut sinon être défini dans **Paramètres > Tokens**.
- Le bouton **Démarrer** ouvre une nouvelle conversation liée au ticket ; le
  bouton **Reprendre** rattache la suite au même ticket et à la même branche.
- Les deux actions retrouvent ou créent le **worktree partagé** de la branche,
  puis injectent un brief court : contexte du ticket, conversations soeurs et
  possibilité d'appeler `read_sibling_conversation` à la demande.
- La configuration projet se fait dans **Réglages du projet > Intégrations** :
  listes ClickUp, projets GitLab, environnements suivis et motif de branche.
- **Sentry** se configure séparément pour chaque projet Pupitre : token local
  opaque, organisation et projets Sentry. L'inbox ne relève que la production,
  toutes les 15 minutes quand l'app est active et toutes les 60 minutes en
  arrière-plan ; un scan manuel reste disponible.
- **Mes domaines** met en avant les issues liées aux domaines permanents du
  projet et aux tickets ClickUp actifs. Pour affilae-mono, le catalogue couvre
  Match AI au sens large (matching, profils affiliés, signup/onboarding et
  vectorisation), Wishlists et Instagram ; Brand Search seul reste exclu.
- Une issue ouvre un détail expurgé, puis **Scout** enquête en lecture seule et
  rend un verdict structuré. Une erreur fixable peut, après confirmation,
  créer son ticket ClickUp, sa branche `issue/TECH-…`, son worktree et une
  conversation de correction. La MR reste soumise à une confirmation distincte.
- La taxonomie **Domaines** vit dans les réglages du projet : le digest propose
  1–2 labels, les pastilles et le filtre de recherche n'affichent que les
  domaines validés. ClickUp (champ Service) et les skills projet amorcent des
  propositions, jamais des labels visibles.
- Elle ne couvre pas encore **Notion / backlog** ni **Répétitions** ; le périmètre complet reste décrit dans
  [le design du chantier](docs/plans/2026-08-19-tableau-de-bord-design.md).

## Coûts, mémoire et aide (M4-N)

- **Coûts** présente l'usage mensuel en tokens par conversation et modèle. Les
  tokens Luna délégués sont comptés comme budget du modèle parent préservé, sans
  inventer de prix en euros.
- **Mémoire** lit et édite `~/.claude/memory` avec écritures atomiques,
  protection contre les chemins extérieurs et confirmation avant suppression ou
  abandon d'un brouillon.
- **Reprendre au terminal** copie `claude --resume`, `codex resume` ou `grok --resume` avec l'id
  de session du fil. L'import inverse est reporté après constat de plusieurs
  formats Codex incompatibles dans l'historique local.
- **Aide** embarque les pages Markdown des concepts Pupitre, les recherche en
  local et reçoit les liens contextuels des écrans et contrôles non évidents.

## Moteur de sous-tâches

Pupitre ne délègue plus de travail à la main du modèle principal : les
sous-agents s'invoquent depuis le prompt, avec les outils natifs du CLI. Le
moteur `sidecar/src/subtasks.ts` reste le lanceur de tours headless de Pupitre
lui-même — c'est par lui que Gardien dispatche ses corrections.

- `SubtaskRunner.start({conversationId, provider, model, effort?, speed?, prompt, label?, readOnly?})`
  lance un tour en arrière-plan dans le cwd du projet parent, **sans prendre le
  verrou de conversation** : la sous-tâche tourne en parallèle du tour parent.
- `GET /api/subtasks/:id` → `{status, resultText, error, subtask}` — `resultText`
  = concaténation des `text-final`, `error` = message du dernier statut terminal
  en échec (`null` sinon). Une sous-tâche qui plante n'écrit souvent aucun
  `text-final` : sans `error`, la carte UI n'a qu'un « ÉCHEC » sans cause.
- `GET /api/subtasks/:id/events` → replay, et `GET /api/conversations/:id/subtasks`
  → les sous-tâches d'une conversation.
- Les événements d'une sous-tâche sont stockés dans la table `events` sous **son
  propre id** : le replay HTTP et le canal `/ws?conversation=<subtaskId>`
  fonctionnent à l'identique d'une conversation.
- Au lancement, un event `subtask-ref` est appendé à la **conversation parente** :
  c'est ce qui permet à l'UI d'afficher la carte. La carte charge d'abord le
  snapshot HTTP et n'ouvre un WebSocket que si elle est **dépliée** ou si la
  sous-tâche **tourne encore** (`ui/src/subtaskStream.ts`). Tant que le snapshot
  n'est pas revenu, la carte est dans un état neutre (« chargement ») — jamais
  « en cours », sinon les cartes historiques gonfleraient le compteur de la
  sidebar à chaque ouverture du fil.
- `POST /api/subtasks/:id/cancel` → `202` (interrompt la sous-tâche en vol,
  statut terminal `error: annulé`), `409` si elle est déjà terminée, `404` si
  l'id est inconnu. Il n'y a **pas** de route de création : le moteur s'appelle
  depuis le sidecar.
- `POST /api/conversations/:id/cancel` annule **en cascade** : le tour parent
  *et* toutes ses sous-tâches en vol (`SubtaskRunner.cancelByConversation`).
  `202` dès qu'il y avait quelque chose à annuler (même sans tour parent en
  cours), `409` sinon.

**Limite de concurrence : 4 sous-tâches simultanées par conversation parente**
(`MAX_CONCURRENT_SUBTASKS`). Au-delà, `start` lève `SubtaskLimitError` et
l'appelant séquence. La limite est par conversation, pas globale.

**Garde de profondeur** : un tour de sous-tâche ne reçoit **jamais** le pont MCP
`pupitre`. Ce n'est pas une convention mais une propriété de structure —
`SubtaskRunner` ne construit pas le champ `pupitre` de `TurnOptions` et aucun
chemin ne permet de l'y ajouter.

## Autonomie d'un tour

Cinq modes, du plus borné au plus ouvert (`AUTONOMY_LEVELS` dans
`ui/src/modelOptions.ts`, `PRESET_PERMISSION_MODES` côté sidecar) ; une
conversation peut aussi hériter du réglage du projet.

| Mode | Ce que le CLI peut faire |
| --- | --- |
| `plan` | Lit et propose. Codex passe en sandbox `read-only`. |
| `default` | Mode natif du provider. Les tours partent en headless : ce qui demanderait une permission est refusé. |
| `acceptEdits` | Éditions de fichiers acceptées d'office ; les commandes restent refusées. |
| `dontAsk` | Édite et exécute sans demander, dans le périmètre du projet. |
| `bypassPermissions` | `--dangerously-skip-permissions` (claude), sandbox `danger-full-access` (codex), `--always-approve` (grok). |

## Presets et réglages (M2-E1)

Les configurations de nouveau tour sont persistées dans `presets` (`provider`, modèle, effort, vitesse, autonomie). Trois presets intégrés sont créés idempotemment — **Éco**, **Qualité max**, **Vitesse**. **Tous les presets sont éditables** via le CRUD HTTP (`/api/presets`) ; `built_in` ne signifie plus « immuable » mais « restaurable et non supprimable » : `POST /api/presets/:id/restore` remet un intégré à ses valeurs d'usine, et le seed au démarrage est un `INSERT OR IGNORE` pur pour ne jamais réécrire une édition. Chaque projet peut mémoriser son choix avec `PUT /api/projects/:id/default-preset`; supprimer un preset personnel efface aussi les défauts projet qui le référencent.

Les réglages transverses vivent dans la table key/value `settings` (`GET/PUT /api/settings`). Au premier démarrage E1, l'UI importe les anciens seuils de notification de quota depuis `localStorage`, les enregistre côté sidecar puis retire la clé historique. Les clés de déduplication des notifications restent locales à la webview.

## Relève des quotas

Les providers n'exposent pas leur état de la même façon, et le `QuotaRefresher` (`sidecar/src/quota-refresh.ts`) cache l'asymétrie derrière un seul appel :

| | Lecture d'état | Pourcentage d'usage | Coût d'une relève |
| --- | --- | --- | --- |
| codex | `account/rateLimits/read` sur l'app-server | oui (`usedPercent`) | gratuit |
| claude | aucune — le `rate_limit_event` n'existe que dans le flux d'un tour, et n'est écrit ni dans les transcripts ni dans un cache | **non**, seulement `resetsAt` | un tour minimal |
| grok | `GET …/v1/billing?format=credits` avec le jeton de `grok login` | oui (`creditUsagePercent`) | gratuit |

La sonde claude (`sidecar/src/adapters/claude-quota.ts`) est donc réduite au strict nécessaire : modèle haiku, prompt système d'une ligne, aucun MCP, aucun hook, répertoire temporaire vide pour ne découvrir aucun `CLAUDE.md`. Au démarrage, elle ne tourne que si le relevé stocké ne couvre plus la fenêtre en cours (`claudeQuotaIsStale`) ; `POST /api/quotas/refresh` la force. Deux relèves simultanées ne paient qu'un seul tour.

L'UI ne comble jamais un trou par une supposition : sans pourcentage publié, elle affiche la date de reset et nomme la donnée manquante.

## Changement de modèle et passation (M2-E2)

Depuis un fil ouvert, la modale « Changer de modèle » distingue deux opérations :

- même provider : `PUT /api/conversations/:id/model` met à jour modèle, effort et vitesse sans casser la session CLI ; l'UI prévient que le cache sera perdu et estime la ré-ingestion en additionnant les événements `usage` du fil ;
- autre provider : `POST /api/conversations/:id/handoff` génère le débrief
  complet sans outils, l'épingle dans le fil source, crée une conversation cible
  reliée par `continued_from`, puis lui transmet ce bilan pour initialiser sa
  propre session. Le bouton Handoff peut aussi produire le document Markdown,
  le copier, l'enregistrer ou créer une nouvelle conversation avec le même
  provider. La sidebar matérialise le lien dans les deux sens.

## Prérequis

- [Bun](https://bun.sh) ≥ 1.3, Rust ≥ 1.77 (+ deps Tauri Linux : `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`…)
- `claude` (Claude Code), `codex` (Codex CLI) et `grok` (Grok Build) installés **et authentifiés** sur leurs abonnements

## Deux instances

| Instance | Port | Données | Lancement |
| --- | ---: | --- | --- |
| stable | 4820 | `~/.local/share/pupitre` | lanceur **Pupitre** |
| dev | 4821 | `~/.local/share/pupitre-dev` | `bun run dev` ou lanceur **Pupitre (dev)** |

La stable utilise des binaires compilés et reste disponible pendant le chantier.
La dev exécute les sources vivantes et désactive par défaut les routines et
rafraîchissements partagés. La pastille de la barre de titre indique l'instance,
le SHA du sidecar et, en dev, si les sources ont changé depuis son démarrage.

## Démarrage de la dev

```bash
bun install
bun run dev           # instance dev : Tauri, Vite et sidecar sur 4821
```

Ou sans fenêtre native :

```bash
bun run dev:sidecar          # sidecar dev sur :4821
bun run --cwd ui dev         # UI sur :5173, proxy vers le sidecar
```

### Données et redémarrage du sidecar dev

```bash
bun run dev:data:refresh     # copie cohérente de la stable vers la dev, dev arrêtée
bun run dev:sidecar          # redémarrage choisi, port 4821
bun run dev:sidecar:watch    # redémarrage à chaque sauvegarde, port 4821
```

Les deux dossiers ne doivent jamais être partagés : chaque démarrage nettoie les
runs orphelins de sa propre base. Les binaires CLI restent surchargeables avec
`PUPITRE_CLAUDE_BIN` et `PUPITRE_CODEX_BIN`.

### Promotion et rollback

```bash
bun run promote                 # construit, attend la stable, installe et relance
bun run promote -- --rollback   # revient à la release précédente
```

La promotion est aussi disponible dans **Paramètres > Instance** de la dev. Elle
attend la fin des tours, installe sans `sudo` sous
`~/.local/opt/pupitre/releases/`, bascule le lien `current`, vérifie le SHA puis
conserve les trois dernières releases.

Par défaut, l'app-server Codex lancé par Pupitre conserve les plugins et MCP
utilisateur, mais borne à 5 secondes le handshake de chaque MCP classique : un
serveur indisponible ne peut donc plus retarder le premier retour de deux minutes.
La borne est appliquée au process puis répétée dans la configuration des threads
qui reçoivent le pont `pupitre`, afin que son ajout ne la remplace pas.
Réglages disponibles :

- `PUPITRE_CODEX_MCP_POLICY=bounded` (défaut) : capacités conservées, démarrage borné ;
- `PUPITRE_CODEX_MCP_POLICY=full` : configuration Codex intacte, sans borne ajoutée ;
- `PUPITRE_CODEX_MCP_POLICY=off` : désactive plugins et MCP utilisateur pour isoler une panne ;
- `PUPITRE_CODEX_MCP_STARTUP_TIMEOUT_SEC=5` : change la borne du mode `bounded`.

L'ancien `PUPITRE_CODEX_USER_MCPS=1` reste compatible et équivaut à `full` si
la nouvelle politique n'est pas renseignée. Les mesures et la commande de probe
sont détaillées dans `docs/spikes/codex-mcp-latency.md`.

Au démarrage, le sidecar réclame son port : si un sidecar d'une session
précédente le tient encore, il lui demande de s'arrêter (`POST /api/shutdown`)
puis prend sa place — l'UI ne peut donc plus tourner sur du code périmé. Un
sidecar arrêté volontairement (exit 0) n'est pas relancé par l'app. À l'arrêt
(SIGTERM, éviction, fermeture de la fenêtre), le sidecar tue le groupe de
process complet de l'app-server Codex : ses serveurs MCP ne survivent plus en
orphelins.

## Tests

```bash
cd sidecar && bun test        # 302 tests (fixtures réelles des CLIs, fake bins)
cd sidecar && bun run typecheck
cd ui && bunx tsc --noEmit && bun run build
```

Protocole e2e : `e2e/basic-flow.md`.

## Documentation

- **Design complet** (vision, features V1, jalons M1-M4) : `docs/plans/2026-08-04-pupitre-design.md`
- **Plan d'implémentation M1** : `docs/plans/2026-08-04-pupitre-m1-implementation.md`
- Formats réels des CLIs : `sidecar/tests/fixtures/README.md`

## Périmètre

**M1 (fait)** : socle — projets, conversations streamées sur les deux providers, reprise, épinglage, images inline, annulation de tour, coquille Tauri.

**M2 (fait)** : sous-tâches, quotas des deux abonnements, presets et changement de modèle. La délégation pilotée par le modèle (Conductor) a été retirée : les sous-agents s'invoquent depuis le prompt.

**M3 (fait)** : Gardien, résumé de session, handoff, bouton Tester avec
preuves, vue Git et durcissement du sidecar.

**M4 (fait)** : bibliothèque de skills, suggestions et workflows, routines,
Fleet, recherche globale et palette, coûts en tokens, mémoire, reprise terminal
et aide intégrée. E2E consolidé et passe design finale réalisés sans quota réel.
