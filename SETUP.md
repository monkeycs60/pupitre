# Installer Pupitre — guide pour vous et votre agent

Pupitre est une application de bureau pour **Linux et macOS 13+** (Apple Silicon et Intel). Elle utilise les CLIs Claude Code et Codex installés sur votre ordinateur. Vos projets, conversations et identifiants restent propres à votre installation.

Le parcours macOS est en cours de validation : les adaptations sont présentes, mais ne considérez pas la compilation CI comme une validation du lancement dans Finder, de l'authentification ou de Claude Design. La recette ci-dessous doit être effectuée sur un vrai Mac avant de déclarer la version validée.

## Le plus simple : confier l'installation à votre agent

Après avoir cloné le dépôt, ouvrez Claude Code dans ce dossier et donnez-lui cette instruction :

> Lis SETUP.md et installe Pupitre sur cet ordinateur avec le setup fourni. Préserve mes configurations et mes données existantes. Prends en charge les commandes et les vérifications. Laisse-moi seulement les connexions aux comptes et les éventuelles validations système. N'importe aucune configuration de Clément. Termine par un lancement réel et indique ce qui reste non vérifié.

L'agent doit exécuter, depuis le dossier cloné :

```bash
bash scripts/setup.sh
```

Sur Mac, vous pouvez aussi double-cliquer **Installer-Pupitre.command** dans le dossier cloné. L'application sera installée dans **votre dossier Applications** (`~/Applications/Pupitre.app`). Vous pourrez la garder dans le Dock ; les lancements suivants n'exigent ni terminal ni serveur à démarrer manuellement.

Le premier build peut prendre plusieurs minutes. Gardez le terminal ouvert jusqu'à la fin. Le setup peut être relancé après un échec : il conserve les outils déjà installés. Une installation existante n'est pas remplacée par le setup.

## Ce que le setup fait

| Étape | Automatique | Intervention éventuelle |
| --- | --- | --- |
| Vérifier macOS et l'architecture | Oui ; refuse Rosetta pour éviter un build de la mauvaise architecture | Aucune en Terminal natif |
| Installer les outils Apple s'ils manquent | Ouvre l'installateur système | Accepter l'installation Apple, attendre sa fin, relancer le setup |
| Installer Bun et Rust s'ils manquent | Oui, depuis les installateurs officiels | Accès réseau |
| Installer Claude Code et Codex s'ils manquent | Oui ; Codex natif depuis openai/codex, archive vérifiée par SHA-256 | Aucun compte partagé dans le code |
| Installer les dépendances et compiler Pupitre | Oui, sans Doppler ni clé API Pupitre | Attendre la fin |
| Connecter Claude et Codex | Réutilise les connexions existantes ; ouvre le login sinon | Se connecter avec les comptes souhaités |
| Installer et ouvrir l'application | Oui | Ajouter ensuite ses dossiers de projets |

Le setup ne configure pas ClickUp, GitLab, Sentry, Grok, Reasonix ou les outils de vos projets. Ils ne sont pas requis pour démarrer des conversations Claude/Codex. Les dépendances propres à chaque projet restent à installer dans ces projets.

Sous Linux, les paquets système Tauri sont contrôlés ; s'ils manquent, le setup affiche la commande Debian/Ubuntu à exécuter. Il n'exécute pas sudo automatiquement. Les autres étapes et le lanceur suivent le même parcours.

## Comptes et projets

- Connectez Codex à **votre compte ChatGPT**, même s'il diffère de celui du propriétaire du dépôt. L'accès aux modèles dépend de votre compte.
- Connectez Claude Code au compte Claude que vous utilisez. Un compte commun ne synchronise pas les données locales Pupitre, mais partage les ressources et limites liées à ce compte.
- N'importez pas les dossiers `~/.claude`, `~/.codex`, `~/.agents` ou les bases Pupitre d'une autre personne.
- Ajoutez vos propres dossiers de projets dans Pupitre. Affilae et les intégrations professionnelles du créateur ne sont pas nécessaires.
- Les skills, plugins, mémoires et fichiers d'instructions utilisés sont ceux présents sur votre machine et dans vos projets.
- Choisissez un fournisseur et un modèle accessibles à votre compte. Certaines fonctions auxiliaires utilisent Codex ; le setup prévoit donc les deux CLIs. `--skip-auth` permet à un agent de terminer l'installation sans connexion interactive, mais il faut ensuite connecter les fournisseurs avant de les utiliser.

## Vérifications obligatoires pour l'agent

1. Exécuter `bash scripts/setup.sh --check` (diagnostic sans installation, sans affichage de jetons). Le code de sortie est non nul si un outil ou une connexion manque. Ce diagnostic ne remplace pas les essais suivants.
2. Fermer puis ouvrir Pupitre depuis Finder ou le menu Linux, sans terminal de développement. Vérifier que l'application charge et que les CLIs restent détectés.
3. Ajouter un dossier personnel, sélectionner un modèle disponible et obtenir une réponse courte de Claude puis de Codex. Ces essais utilisent les quotas habituels.
4. Fermer et relancer l'application ; vérifier la conservation du projet et des conversations et la reprise d'un fil.
5. Tester l'ouverture d'un document, le panneau Claude Design si utilisé et la détection d'une application locale. Une éventuelle permission macOS d'automatisation de Terminal doit être validée pour la reconnexion depuis Pupitre.
6. Rapporter les versions de macOS, Bun, Rust et des CLIs, les essais réussis et les limites, sans secrets ni captures d'identifiants.

Ne pas annoncer « validé sur Mac » sur la seule base des tests Linux ou d'un workflow de compilation.

## Diagnostic et mise à jour

```bash
bash scripts/setup.sh --check
```

| Symptôme | Action |
| --- | --- |
| Outils Apple en cours d'installation | Attendre, puis relancer le setup |
| Installation interrompue | Corriger l'erreur affichée et relancer ; ne pas effacer les données |
| Connexion Claude absente | `claude auth login` dans Terminal, ou reconnexion depuis Pupitre |
| Connexion Codex absente | `codex login` dans Terminal, ou reconnexion depuis Pupitre |
| Mauvais modèle / modèle inaccessible | Choisir un modèle disponible sur son compte |
| CLI visible dans Terminal mais pas dans Finder | Vérifier le PATH enregistré dans `~/.config/pupitre/path` ; mettre à jour ce fichier si l'emplacement des outils a changé |
| `~/Applications/Pupitre.app` existe déjà hors de ce setup | Préserver cette application et la déplacer manuellement avant de relancer ; le setup refuse de l'écraser |
| Port 4820 occupé | Identifier l'application avant d'agir ; ne jamais tuer un processus inconnu |

Les données sont dans `~/.local/share/pupitre`. Les releases sont dans `~/.local/opt/pupitre/releases`. Le dossier cloné reste nécessaire aux futurs builds, mais pas au lancement de l'application déjà installée. Ne supprimez pas le répertoire des releases : le lanceur Mac y pointe.

Pour une mise à jour explicitement souhaitée, depuis le dépôt et hors d'une conversation de la stable :

```bash
git pull --ff-only
bun install --frozen-lockfile
bun run promote
```

La promotion attend la fin des tâches, conserve les anciennes releases et vérifie que la fenêtre a rejoint le nouveau backend. En cas de problème : `bun run promote -- --rollback`. Ne pas lancer une mise à jour depuis un agent qui tourne dans la stable à remplacer.

## Développer ou construire un installateur

```bash
bun run dev
```

La dev utilise le port 4821 et `~/.local/share/pupitre-dev`, sans toucher aux données de la stable. Doppler est optionnel : `bun run dev:secrets` conserve le parcours de développement avec secrets pour les personnes qui l'utilisent.

Pour produire un DMG sur Mac :

```bash
bunx tauri build --bundles dmg
```

Le workflow GitHub « Desktop Linux et macOS » construit les variantes Linux, Mac ARM et Mac Intel et conserve les binaires en artefacts. Un bundle téléchargé est distinct d'un build local : pour une distribution grand public sans alertes Gatekeeper, prévoir signature Developer ID et notarisation Apple. Le setup ne désactive aucune protection macOS et ne supprime pas les attributs de quarantaine.

Références : [Tauri / prérequis](https://v2.tauri.app/start/prerequisites/), [distribution Mac](https://v2.tauri.app/distribute/dmg/), [Claude Code](https://code.claude.com/docs/en/setup), [Codex](https://github.com/openai/codex), [Bun](https://bun.sh/docs/installation).
