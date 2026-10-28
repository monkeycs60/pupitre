# Pupitre sur un serveur privé

L'interface compilée fonctionne dans un navigateur. Le sidecar reste sur
`127.0.0.1:4820` ; Nginx sert les fichiers statiques et relaie API, médias et
WebSocket sur `127.0.0.1:4880`. Tailscale Serve termine HTTPS et fournit
l'identité du visiteur. Aucun port Pupitre ne doit écouter sur une interface publique.

## Installation OVH de Clément

- Adresse : `https://vps-139a77b3.tailfd41cd.ts.net/`.
- Accès depuis le téléphone : Tailscale connecté au compte personnel, puis ouvrir
  l'adresse dans Chrome. Ajouter à l'écran d'accueil si souhaité.
- Compte Linux : `pupitre`, sans sudo et sans groupe Docker. Dossier privé
  `/home/pupitre` ; projets GitHub dans `/home/pupitre/projects`.
- Sources exécutées : `/home/pupitre/app`. Interface compilée : `/var/www/pupitre`.
- Outils : `/opt/pupitre/bin/bun`, `/opt/pupitre/bin/claude`,
  `/home/pupitre/.local/bin/codex` et son compagnon `codex-code-mode-host`.
- Chrome : `/opt/pupitre/chrome/chrome`, binaire appartenant à root. Le profil
  AppArmor `scripts/server/chrome.apparmor` autorise ses namespaces sans désactiver
  la sandbox de Chrome ou les restrictions globales Ubuntu.
- `ab` et les skills du serveur utilisent un navigateur headless séparé par
  conversation. Les cookies et comptes du Chrome du PC n'y sont pas copiés.
- Les conversations du serveur sont indépendantes de celles du PC.

## Services

Installer les fichiers `scripts/server/*.service` et `*.timer` dans
`/etc/systemd/system`, puis lancer `systemctl daemon-reload` et activer
`pupitre`, `pupitre-web` et `pupitre-backup.timer`. Ces unités repartent au boot.
Le sidecar redémarre après une sortie, y compris après un crash.

Le compte agent est limité à deux cœurs CPU et 6 Gio de RAM, navigateur et
processus enfants compris. Il ne peut pas lire `/home/ubuntu`, les données
Coolify ou le socket Docker. Ces limites protègent les applications déjà hébergées.

`PUPITRE_BACKGROUND_JOBS=on` conserve les routines et le suivi habituel.
`PUPITRE_CHANGELOG_JOBS=off` évite d'analyser automatiquement tout l'historique Git
des dix nouveaux dépôts. Le rafraîchissement demandé explicitement reste disponible.

## Gateway et Tailscale

Remplacer `__HOST__` et `__LOGIN__` dans `scripts/server/nginx.conf.template`
par le nom DNS Tailscale et l'identité autorisée, puis enregistrer le résultat
dans `/etc/pupitre/nginx.conf`, appartenant à root.

```bash
sudo tailscale serve --bg --yes --https=443 http://127.0.0.1:4880
sudo tailscale serve status
```

Serve doit rester privé : ne pas utiliser Funnel. La configuration Nginx exige
l'identité injectée par Serve et refuse les origines tierces. Elle réécrit
l'origine uniquement après ces contrôles pour joindre le sidecar local.

## Comptes

Connecter les CLIs dans le compte `pupitre`, depuis son dossier personnel. Une
connexion OAuth propre au serveur évite que le renouvellement d'un cache copié
entre deux machines invalide l'autre installation.

```bash
sudo -u pupitre -H bash
cd ~
claude auth login
codex login
```

Le login Codex standard peut utiliser un tunnel SSH pour le callback
`127.0.0.1:1455`, ou `codex login --device-auth` si activé sur le compte.
Les validations de compte et de navigateur restent interactives.

Ne copier ni les accès de production, ni les configurations professionnelles.
Pour développer une application avec base de données, préparer une base dédiée ;
les bases applicatives de production restent hors de portée de ce compte.

## Sauvegardes

Chaque jour à 04:15 UTC, `pupitre-backup.timer` crée un snapshot SQLite à chaud
avec `VACUUM INTO`, puis archive ce snapshot avec documents et médias dans
`/home/pupitre/backups`. Les quatorze dernières archives sont conservées.
Les caches OAuth et jetons GitHub ne font pas partie de cette sauvegarde.

```bash
sudo systemctl start pupitre-backup.service
sudo journalctl -u pupitre-backup.service -n 10
```

Pour restaurer, arrêter `pupitre`, conserver une copie du dossier de données
actuel, extraire une archive dans un dossier temporaire et vérifier
`PRAGMA integrity_check`. Remplacer `pupitre.db`, `documents` et `media` avec
ceux de l'archive ; supprimer les anciens fichiers `pupitre.db-wal` et
`pupitre.db-shm`, rétablir le propriétaire `pupitre`, puis relancer le service.

Ces archives restent sur le VPS : elles ne protègent pas contre sa perte totale.
Une copie extérieure doit être configurée séparément.

## Maintenance et retour arrière

```bash
sudo systemctl status pupitre pupitre-web
sudo journalctl -u pupitre -n 50
sudo systemctl restart pupitre
```

Avant de changer les sources, attendre que `/api/fleet` soit vide et sauvegarder
les données. Conserver l'ancienne copie des sources et de l'interface compilée.
Installer les dépendances avec `bun install --frozen-lockfile`, compiler
`bun run --cwd ui build`, copier `ui/dist` dans `/var/www/pupitre`, puis relancer
uniquement le service `pupitre`. La stable du PC n'est pas concernée.

Pour retirer l'accès web, exécuter `sudo tailscale serve --https=443 off` et
arrêter `pupitre-web`. Les projets et conversations restent sur le disque.

Références : [Tailscale Serve et identité](https://tailscale.com/docs/features/tailscale-serve#identity-headers),
[authentification Codex sur un serveur](https://learn.chatgpt.com/docs/auth).
