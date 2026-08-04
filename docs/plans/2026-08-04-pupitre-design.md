# Pupitre — Design

**Date** : 2026-08-04
**Statut** : design validé (session de brainstorming Clement × Claude)
**Nom** : `pupitre` — le pupitre du chef d'orchestre : l'app dirige les CLIs sans jouer une note elle-même.

## 1. Vision

App bureau Linux (mission control complet) qui remplace l'usage de l'app ChatGPT (wrapper Electron lent) et une partie de l'usage terminal. On discute dedans, elle pilote **Claude Code** et **Codex CLI** en arrière-plan.

Principes fondateurs :

- **Deux abonnements, zéro API payante.** L'app pilote les CLIs authentifiés (`claude` en OAuth abonnement, `codex` en compte ChatGPT). Tout est facturé sur les abos.
- **Orchestrateur puissant, sub-agents rapides et pas chers.** Un cerveau (Fable 5 / Opus 5 high / GPT-5.6 Sol high) délègue à des exécutants (GPT-5.6 Luna extra high fast, mode rapide).
- **Cross-provider dans les deux sens.** Claude peut déléguer à Codex, Sol peut déléguer à Claude.
- **Tout inline dans la conversation.** Screenshots, cartes de sub-agents, previews d'artefacts : dans le fil, pas dans des panneaux séparés (exception : le panneau de suggestions de skills, demandé explicitement).
- **La navigation web (Claude in Chrome, Playwright) est une feature de premier plan.**

## 2. Architecture

```
┌─────────────────────────────────────────────┐
│  Tauri 2 (Rust minimal)                     │
│  fenêtre, tray, notifs natives, autostart   │
│  └── spawn du sidecar au démarrage          │
├─────────────────────────────────────────────┤
│  Sidecar Bun/TypeScript  ← le cerveau       │
│  • ProjectStore + SessionStore (SQLite)     │
│  • ClaudeAdapter  → claude (Agent SDK /     │
│    stream-json, --resume, permissions)      │
│  • CodexAdapter   → codex app-server        │
│    (protocole JSONL : events, approvals,    │
│    resume, usage)                           │
│  • Conductor (orchestration cross-provider) │
│  • QuotaTracker (5h/weekly Claude, ChatGPT) │
│  • SkillIndex (bibliothèque + suggestions)  │
│  • WebSocket ⇄ frontend                     │
├─────────────────────────────────────────────┤
│  Frontend React + Vite (webview Tauri)      │
└─────────────────────────────────────────────┘
```

- **Pourquoi « Rust minimal »** : dans Tauri l'UI est de toute façon du web (webview système) ; le Rust ne fait que la coquille native (fenêtre, tray, notifs, spawn du sidecar). La logique métier vit en TypeScript car (1) le goulot de perf est dans les CLIs, pas dans la plomberie JSON/process de l'app, (2) c'est la stack de Clement et des sub-agents de dev, (3) l'Agent SDK Claude est TS. La légèreté anti-Electron vient de Tauri (pas de Chromium embarqué), pas du langage de la logique. Si un morceau devient un vrai goulot (parsing massif, FTS), migration ponctuelle en Rust possible.
- **Schéma d'événements unifié** : les deux adapters normalisent tout (deltas de texte, tool calls, images produites, demandes de permission, usage tokens). Le frontend ne connaît jamais Claude ou Codex directement — c'est ce qui rend le choix d'orchestrateur par conversation trivial côté UI.
- **Images/artefacts** : stockés sur disque avec miniatures, référencés dans SQLite.
- **Les sessions sont celles des vrais CLIs** (`claude --resume <id>`, `codex resume`) : les skills, MCP servers, CLAUDE.md/AGENTS.md existants marchent tels quels, et le handoff terminal ⇄ app est naturel.

## 3. Concepts de base

- **Projet = dossier de code** (`~/Desktop/spoilguard`, `affilae-mono`…). Les conversations tournent dans ce working directory et héritent du CLAUDE.md/AGENTS.md local. L'app liste les repos existants.
- **Conversations par projet**, épinglables, reprenables (session en cours ou passée).
- **Permissions par projet** : chaque projet définit son niveau (perso = yolo/auto-accept, affilae-mono = approbations dans l'UI). Les conversations héritent, override ponctuel possible. Les demandes de permission remontent dans l'UI avec Autoriser/Refuser + « toujours autoriser » par projet.

## 4. Orchestration cross-provider (le Conductor)

- **Config par conversation** : orchestrateur (provider + modèle + effort), pool de sub-agents par défaut, modèle de review. Changeable à la volée. Chaque combinaison sauvegardable en **preset nommé** (« Éco », « Qualité max », « Vitesse »…), avec un preset par défaut par projet.
- **Mécanique** : serveur MCP maison (`Conductor`) branché aux deux CLIs. Outils exposés à l'orchestrateur : `delegate` (une sous-tâche → un modèle), `delegate_parallel` (fan-out), `collect`. Sol orchestre → spawn `claude -p` headless ; Claude orchestre → spawn `codex exec --model luna`. Chaque sub-agent tourne dans le working directory du projet avec skills/CLAUDE.md/AGENTS.md.
- **Dans le fil** : chaque délégation = carte dépliable inline (badge modèle, statut live, durée, tokens, transcript complet + screenshots en dépliant). Fan-out = plusieurs cartes qui avancent en parallèle.
- **Routage conscient des quotas** : quand l'orchestrateur demande « un modèle rapide pas cher » sans préciser, le Conductor peut router vers l'abonnement qui a le plus de marge — **facultatif, off par défaut**, activable par preset (voir §8).

## 5. Changement de modèle à la volée

Le switch mid-conversation invalide le cache (même provider) ou rend l'historique intransférable (cross-provider). Une modale avertit et propose :

1. **Continuer avec l'historique** (même provider seulement) : contexte conservé, cache perdu — estimation affichée (« re-ingestion ≈ 85k tokens ») avant confirmation.
2. **Handoff par débrief** (recommandé ; seule option cross-provider) : l'app génère le Débrief (§7), l'épingle, et démarre une session fraîche avec le nouveau modèle seedée avec ce débrief + les épingles du projet.
3. **Annuler.**

Le choix est mémorisable dans le preset (« toujours handoff par débrief »).

## 6. Le Gardien — review à risques surlignés

Après chaque session de travail d'un agent, review automatique du diff **avant** validation humaine. Objectif : identifier vite ce qui peut merder / provoquer des side effects.

- **Scan de risques** : modèles par défaut **Opus 5 high** (côté Claude) / **GPT-5.6 Sol high** (côté GPT) — changeable à la volée, sauvegardé en preset. Les modèles pas chers ratent les risques transversaux : cheap uniquement pour le pré-découpage du diff en zones, **jamais pour juger**. Grille : perte de données, side effects sur modules partagés, changement de contrat d'API, migration/schéma, comportement silencieusement modifié, gestion d'erreur supprimée, secret/credential, absence de test sur code critique.
- **Diff thermique** : rouge (peut casser la prod / perdre des données), orange (side effect probable), gris (cosmétique). Chaque flag ancré à des lignes précises, avec une phrase concrète et actionnable.
- **Validation ciblée (anti-vibecoding)** : pas de bouton « Approve » global — l'app extrait 2-4 décisions explicites à acquitter une par une (« OK pour que l'endpoint change de format de réponse ? »).
- **Contre-avis cross-provider** : à la demande, **par point ciblé ou d'un coup sur tous les points**. Si Claude a écrit le code, c'est Sol qui contre-review (et inversement). Objectif = **certitude** (confirmer/infirmer chaque risque), pas chasse au faux positif. Modèle/effort du contre-avis choisissables.
- **Niveaux de blocage par projet** : perso = flags informatifs ; pro = flag rouge non acquitté bloque le commit. Contre-avis automatique sur flag rouge configurable par projet.

## 7. Le Débrief — bouton « Reprendre le contrôle »

À tout moment, génère un bilan structuré depuis le début (ou depuis le dernier débrief) :

- **Ce qui a été construit** (langage humain, pas liste de fichiers)
- **Les décisions prises et pourquoi** (+ alternatives écartées) — pour pouvoir justifier devant un collègue/supérieur
- **Les implications** (dépendances créées, ce que ça change pour la suite)
- **Ce qui reste ouvert** (TODO implicites, raccourcis, zones non testées)

Épinglé dans la conversation, versionné (la série des débriefs raconte l'histoire du projet). Mode « explique-moi comme à un collègue » : Q&A sur le débrief avec citation du moment de la conversation où ça s'est décidé. Le débrief sert aussi d'artefact de handoff (§5) et de réponse à la saturation de contexte (§10).

## 8. Quotas & coûts

**Signaux, pas d'automagie** — le routage automatique est off par défaut.

- **Chips de quota sur le sélecteur de modèle** : « Opus 5 · 62% · reset 14h30 » à côté de chaque nom.
- **États visuels** : jauge verte → orange en dernière heure de fenêtre 5h ; **pulse « use it or lose it »** quand il reste beaucoup de quota et peu de temps → le spot Fable 5, pour donner l'idée de l'utiliser plutôt que le perdre. Pareil pour le weekly, et symétriquement côté ChatGPT.
- **Notifications natives** aux seuils réglables (dernière heure de fenêtre, 80% du weekly, quota ChatGPT bas).
- **Barre de statut permanente** : mini-jauges Claude (5h + weekly) et ChatGPT, compte à rebours de reset au survol.
- **Coûts par conversation** : tokens, répartition par modèle, « économie de délégation » (ce que les sous-tâches Luna auraient coûté en Fable 5). Vue mensuelle par projet.

## 9. Bibliothèque de skills & suggestions

- **Inventaire unifié** : scan + watch de `~/.claude/skills`, plugins Claude Code, `.claude/skills/` projet, `~/.codex/prompts`, `AGENTS.md`. Index : nom, description, triggers, provenance. Vue Bibliothèque : recherche, filtres provider/projet, aperçu SKILL.md, favoris par projet.
- **Pont cross-provider** : skills Claude injectés dans les runs Codex (conversion à la volée), prompts Codex invocables depuis Claude.
- **Panneau latéral de suggestions** (le seul panneau) : matcher léger (embeddings locaux sur descriptions + triggers, appel Luna fast pour les cas ambigus) propose 2-3 skills pertinents en temps réel, bouton « Lancer ». Ex : photo de livre collée → `annonce-livre-vinted` ; ticket client → `csm-support`.
- **Composer de skills** : « Nouveau skill » → description du besoin → l'orchestrateur rédige le SKILL.md (via `skill-creator`) et l'installe dans la bonne source.

## 10. UI

**Barre latérale gauche** : Projets (avec conversations, épinglées en haut, **workflows épinglés** one-click sous le nom du projet) ; en bas : Bibliothèque de skills, Routines, Fleet view, Réglages.

**Vue conversation** : fil avec cartes de sub-agents dépliables, screenshots inline (lightbox), previews d'artefacts (HTML, PDF, **CSV en tableau, vidéos lisibles**), débriefs épinglés en accordéon. Composer : texte + collage d'images, sélecteur de modèle avec chips de quota, sélecteur de preset, boutons **« Reprendre le contrôle »** et **« Tester »**. Panneau droit repliable : skills suggérés.

**Onglets par projet** : Conversations · **Git** (graphe visuel des branches, commits tagués par conversation d'origine, worktrees, diff entre branches en un clic ; les flags du Gardien restent visibles sur les commits) · **Gardien** (reviews en attente, diff thermique, validation ciblée, contre-avis).

**Permanent** : barre de statut avec jauges d'abonnement ; **jauge de contexte** de la conversation en cours avec suggestion de handoff-débrief à l'approche de la saturation (pas d'auto-compact surprise).

**Fleet view** : grille de tout ce qui tourne, tous projets confondus — statut, durée, dernier screenshot, « rejoindre la conversation ».

**Recherche globale** : plein-texte (SQLite FTS) sur conversations, débriefs, épingles. **Palette Ctrl+K** : navigation, workflows, skills, Tester/Débrief/Review au clavier.

**Aide intégrée** (l'app a beaucoup de concepts maison — Gardien, Débrief, presets, contre-avis — ils doivent s'expliquer eux-mêmes) :
- **Onglet Aide** : documentation des features de l'app, searchable, une page par concept avec capture annotée. Alimenté depuis des fichiers markdown du repo (`docs/help/`) pour rester à jour avec le code.
- **Tooltips systématiques** au survol de tout bouton ou badge non évident (chips de quota, pulse use-it-or-lose-it, flags du Gardien, boutons Tester/Débrief/contre-avis) : une phrase qui dit ce que ça fait ET pourquoi on s'en sert, avec lien « en savoir plus » vers la page d'aide.
- **Empty states explicatifs** : un écran vide (aucune review en attente, aucune routine) explique ce que la feature fera quand elle servira, au lieu d'un vide muet.

## 11. Le bouton « Tester »

1. **Inventaire** : relit la conversation, liste ce qui a été implémenté et est testable.
2. **Choix du scope** : si plusieurs features/composantes, demande quoi tester d'abord avec pistes concrètes par item (test unitaire, parcours navigateur Playwright/Claude in Chrome, étapes manuelles guidées).
3. **Exécution avec preuves inline** : screenshots du parcours, sorties de tests, verdict par scope.
4. **Boucle avec le Gardien** : les flags « non testé » alimentent les suggestions de scope ; un scope testé avec succès éteint le flag.

## 12. Autres features validées

- **Workflows épinglés par projet** : un workflow = skill + prompt pré-rempli + modèle (« Photo → annonce Vinted », « Ticket → réponse CSM », « Sync Strava → bilan »).
- **Tableau des routines** : tâches récurrentes en cron avec historique des runs, sorties, coûts.
- **Handoff terminal ⇄ app** : bouton copie `claude --resume <id>` ; détection des sessions terminal pour reprise dans l'UI.
- **Explorateur de mémoire** : vue sur `~/.claude/memory/` — lire, corriger, supprimer.
- **Notifications natives Linux** : fin de tâche longue, demande de permission, seuils de quota (intégrer l'esprit du plugin claude-notifications-go nativement).

## 13. Hors périmètre V1

- **Vocal** : Clement utilise Whispering (externe). Pas de mode vocal intégré.
- **Panneau navigateur dédié** : rejeté — les screenshots vivent inline dans le fil.

## 14. Gestion d'erreurs

- **Crash d'un CLI/adapter** : la conversation passe en état « interrompue », bouton reprise via `--resume`/`codex resume` (les sessions sont persistées par les CLIs eux-mêmes — rien n'est perdu).
- **Sidecar down** : le shell Tauri le relance, le frontend se resynchronise via SQLite (source de vérité des métadonnées).
- **Sub-agent en échec** : la carte inline passe en erreur avec le transcript ; l'orchestrateur décide (retry, autre modèle, remontée à l'utilisateur).
- **Quota épuisé mid-run** : détection via les événements d'usage des CLIs, pause propre + notification + proposition de basculer sur l'autre provider (via handoff-débrief si nécessaire).

## 15. Tests

- **Adapters** : tests unitaires sur fixtures JSONL enregistrées (transcripts réels `claude -p --output-format stream-json` et `codex app-server`) — le schéma unifié est la surface de contrat à tester en priorité.
- **Conductor** : tests d'intégration avec sub-agents mockés (process factices qui rejouent des fixtures).
- **UI** : e2e Playwright sur les parcours clés (créer projet, lancer conversation, délégation, review Gardien, switch de modèle).
- **Dogfooding** : Pupitre développé avec Pupitre dès que le socle tourne.

## 16. Contraintes d'implémentation

- **Sub-agents d'implémentation : GPT-5.6 Sol high via Codex CLI** (demande explicite de Clement — pas de Fable pour l'exécution des sous-tâches de dev).
- Stack : Tauri 2 (Rust minimal), Bun/TypeScript pour le sidecar, React + Vite pour le frontend, SQLite.
- Jamais d'API payante : uniquement les CLIs authentifiés sur abonnement.

## 17. Risques & questions ouvertes

- **Stabilité du protocole `codex app-server`** : non documenté officiellement, peut bouger entre versions — l'adapter doit être versionné et testé sur fixtures.
- **Introspection des quotas** : comment lire programmatiquement l'état 5h/weekly Claude (`/usage`) et les limites ChatGPT — à explorer en spike au début du build (fallback : estimation locale par comptage d'usage).
- **Fidélité de la conversion skills → Codex** : les skills complexes (avec scripts, références) peuvent perdre en route ; commencer par l'injection du SKILL.md seul.
- **Détection des sessions terminal** pour le handoff : formats internes des CLIs, à valider.

## 18. Ordre de construction proposé

1. **M1 — Socle** : Tauri + sidecar + adapters, projets, conversations, streaming, reprise, images inline, épinglage.
2. **M2 — Orchestration & quotas** : Conductor MCP, cartes de sub-agents, presets, QuotaTracker + chips/jauges/notifs, switch de modèle propre.
3. **M3 — Contrôle** : Gardien (scan, diff thermique, validation ciblée, contre-avis), Débrief, bouton Tester, vue Git.
4. **M4 — Confort** : bibliothèque de skills + suggestions, workflows épinglés, routines, fleet view, recherche globale, Ctrl+K, explorateur de mémoire.
