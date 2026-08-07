# Skills

Pupitre rassemble les instructions réutilisables de Claude et Codex dans une
bibliothèque locale. Aucun fichier n'est envoyé à un service d'indexation : le
sidecar lit les sources présentes sur la machine et garde leurs métadonnées dans
SQLite.

## Sources indexées

- `~/.claude/skills` et les skills des plugins Claude Code ;
- `.claude/skills` dans chaque projet Pupitre ;
- `~/.codex/prompts` ;
- `AGENTS.md` global et par projet.

Le watcher actualise l'index quand un fichier change. Le bouton **Actualiser**
permet de forcer une relecture immédiate. La recherche porte sur le nom, la
description et les déclencheurs. Un favori appartient au projet sélectionné : il
n'affecte pas les autres projets.

## Invoquer un skill

Préfixez la demande par son invocation affichée dans Pupitre :

```text
$csm-support Réponds à ce ticket en citant la documentation pertinente.
```

Cette syntaxe est identique dans une conversation Claude ou Codex. Pupitre joint
le contenu du `SKILL.md` au prompt envoyé au modèle, mais conserve votre message
original dans l'historique.

Limite v1 : seul le `SKILL.md` traverse le pont. Un skill qui dépend de scripts,
de fichiers `references/` ou d'assets peut donc perdre une partie de ses moyens
quand il est utilisé par l'autre provider.

## Suggestions

Le rail **Skills** ouvre le seul panneau latéral de l'application. Il compare les
mots du brouillon — ou, si le composer est vide, du dernier message — aux
descriptions et déclencheurs indexés. **Ajouter au message** préfixe le brouillon
avec l'invocation
sans envoyer le message.

Le panneau est fermé par défaut et mémorise votre choix. Le matching reste local
et lexical. Si au moins quatre résultats ont des scores proches, Luna fast peut
les départager, uniquement lorsque le panneau est ouvert et que le texte est
resté stable.

## Créer un skill

Dans **Bibliothèque**, choisissez **Nouveau skill**, décrivez le besoin et la
portée :

- **Ce projet** écrit `.claude/skills/<nom>/SKILL.md` dans le projet courant ;
- **Tous les projets** écrit `~/.claude/skills/<nom>/SKILL.md`.

Codex Sol rédige le fichier. Si un `skill-creator` est indexé, ses instructions
sont incluses dans la génération. Pupitre normalise le nom en kebab-case, refuse
d'écraser un fichier existant puis indexe le nouveau skill. La v1 ne génère pas
de scripts, références ou assets annexes.
