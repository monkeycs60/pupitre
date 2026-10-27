---
name: agent-browser
description: Piloter le Chrome ouvert de l'utilisateur avec ses sessions, via ab. Utiliser pour @browser, vérifier une page, tester un parcours web ou faire une capture dans le navigateur.
---

# Agent browser

Commande : `ab`, ou `~/.claude/skills/agent-browser/scripts/ab` si elle n'est pas dans le PATH. Ce wrapper fonctionne sur macOS et Linux avec le binaire installé par Pupitre. Il crée un onglet propre à la conversation Claude Code ou Codex et conserve ce même onglet entre les commandes.

## Première connexion

Chrome 144+ doit être ouvert avec le profil souhaité. L'utilisateur active le débogage dans `chrome://inspect/#remote-debugging`, puis accepte la demande de connexion de Chrome. Si Chrome manque, installer Google Chrome depuis https://www.google.com/chrome/ avec l'utilisateur, puis l'ouvrir. Ne pas exporter les cookies ou reprendre le profil d'une autre personne.

Si une autorisation est attendue, le signaler à l'utilisateur puis réessayer après sa réponse. Une nouvelle conversation ou un redémarrage peut demander une nouvelle autorisation. Ne pas contourner cette validation. Le wrapper ne garantit pas que Chrome reste en arrière-plan.

## Piloter la page

```bash
ab open https://example.com
ab snapshot -i
ab click @e3
ab get text body
ab screenshot /tmp/verification.png
ab close
```

Privilégier le snapshot pour lire et interagir ; prendre une capture pour juger le rendu. Refaire le snapshot après navigation ou modification de la page : les références `@eN` deviennent périmées. `ab --help` donne les autres commandes.

Les commandes restent attachées à l'onglet de la conversation. Si cet onglet a été fermé (`tab_gone`), exécuter `ab tab new about:blank`, puis reprendre. Terminer par `ab close`, qui ferme uniquement cet onglet. Ne pas fermer ni naviguer les autres onglets sans demande de l'utilisateur.

Les actions ont lieu dans les vrais comptes de l'utilisateur : un accès au navigateur n'autorise pas à lui seul un envoi, un achat, une publication ou une suppression.

## Prouver un parcours en vidéo

Un changement de comportement d'interface (parcours, navigation, formulaire, état qui évolue) se prouve par une vidéo du même parcours **avant et après**, en plus des captures clés. Une capture suffit pour un simple réglage visuel.

```bash
ab set viewport 1440 900
ab record start /tmp/preuve/apres.webm http://localhost:3000/page --fps 15 --cursor
ab click @e3 && ab wait 800     # une pause entre deux étapes, pour qu'on suive
ab record stop
ffmpeg -loglevel error -y -i /tmp/preuve/apres.webm -c:v libx264 -pix_fmt yuv420p \
  -crf 28 -preset veryfast -movflags +faststart -an /tmp/preuve/apres.mp4
```

- `ab record` exige ffmpeg avec libx264 et libvpx (`brew install ffmpeg` sur macOS, `sudo apt install ffmpeg` sur Linux) ; `ab doctor` le vérifie.
- L'« avant » se tourne sur la branche de base (worktree ou checkout de la branche principale), avant de toucher au code quand c'est possible. Même parcours, même compte, même taille de fenêtre : c'est la comparaison qui parle.
- `--cursor` est obligatoire : sans lui, les clics de l'agent ne laissent aucun pointeur à l'image et on ne voit pas où il agit. Il dessine un pointeur et une onde à chaque clic, qui suivent la navigation.
- Enregistrer en `.webm`, puis convertir. Machine chargée, l'encodeur MP4 direct échoue (`Recording encoder fell more than 500 ms behind capture`) et laisse un fichier illisible. Si `record stop` affiche ✗, refaire la prise.
- Le rapport embarque du MP4 H.264, lu par l'app Pupitre sur macOS comme sur Linux. Un parcours de 30 s pèse environ 150 Ko.
- Dans le rapport HTML publié avec `publish_document` : `<video controls muted playsinline preload="metadata" title="Après · ajout d'un profil" src="data:video/mp4;base64,…">`. Pupitre agrandit la vidéo au clic, prend le `title` (ou la `<figcaption>`) comme légende, passe d'un média à l'autre aux flèches, ligne par ligne puis de gauche à droite, et lit côte à côte deux vidéos voisines : poser chaque avant à gauche de son après, sur la même ligne.

## Installation et diagnostic

Si le binaire manque, depuis le dépôt Pupitre : `bun run setup:browser`. Ce setup préserve les skills et commandes personnels existants ; il indique les conflits éventuels. Ouvrir une nouvelle conversation après l'installation pour que le skill soit découvert.

Un relais CDP existant peut être choisi avec `AB_RELAY`. Ce paquet n'installe pas le relais Linux personnel du créateur de Pupitre.
