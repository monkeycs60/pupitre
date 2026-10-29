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
- Projet modifiable : `/home/pupitre/projects/pupitre`. Les versions en service
  sont compilées et protégées dans `/opt/pupitre/releases` ; le compte agent
  ne peut pas les réécrire. `/var/www/pupitre` pointe sur leur interface.
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

La console indépendante se trouve à
`https://vps-139a77b3.tailfd41cd.ts.net:8443/`. La conserver en favori sur le
téléphone : elle ne dépend ni du sidecar, ni du front, ni du Nginx de Pupitre.
Elle possède sa propre unité `pupitre-control.service` et utilise Python fourni
par Ubuntu. Tailscale joint son socket Unix, accessible uniquement à root.
Les contrôles exigent l'identité Tailscale autorisée, une origine correcte et un
jeton anti-CSRF. Ils n'acceptent aucun chemin, commande shell ou argument libre.
Les appels provenant du VPS lui-même sont refusés : une version défaillante ne
peut pas confirmer sa propre mise à jour. La confirmation vient du téléphone
ou d'un autre appareil personnel connecté à Tailscale.

### Depuis le S26

1. Dans le projet Pupitre du VPS, demander à l'agent de modifier le projet puis
   de créer un commit. Les modifications non commitées bloquent la préparation.
2. Ouvrir « Mises à jour et secours » dans la barre supérieure, puis
   « Préparer la version ». Les dépendances sont téléchargées sans leurs scripts
   d'installation, puis types, tests et compilation tournent dans un compte
   dédié sans réseau et sans accès à `/home` ou aux comptes des fournisseurs.
3. « Ouvrir le test » ouvre le port HTTPS 10000. Cette instance utilise un autre
   compte Linux et une copie des données ; les accès Claude et Codex n'y sont
   pas copiés. Les tests UI n'ouvrent aucun socket vers le véritable sidecar.
4. « Appliquer la version » refuse les agents encore actifs, arrête uniquement
   Pupitre, prend un instantané complet puis bascule vers les fichiers gelés.
5. Ouvrir Pupitre, vérifier le fonctionnement, puis confirmer dans le secours
   sous **trois minutes**. Sans confirmation, ou après trois sondes de santé
   en échec, le secours restaure automatiquement code et données précédents.

La préparation et le test ne remplacent pas la version en service. Le système
vérifie les empreintes de tous les fichiers avant une bascule. La confirmation
est requise même si les sondes répondent : une interface vide peut laisser le
backend fonctionner. Un redémarrage du secours ou du VPS pendant une mise à
jour non confirmée déclenche également la restauration, grâce à une transaction
enregistrée avant la première modification.

### Si Pupitre est cassé

Ouvrir directement le favori du secours. « Restaurer la précédente » remet la
version et l'instantané conservés avant la dernière promotion. « Redémarrer
Pupitre » conserve ses données. Le secours avancé permet d'arrêter les agents
encore actifs ou d'intervenir si leur état est impossible à lire. Il permet
aussi de restaurer la référence protégée lors de l'installation du secours.

**Une restauration rétablit les conversations à la date de son instantané.**
Le dossier remplacé est conservé sous
`/home/pupitre/.local/share/pupitre-retained-<timestamp>` ; les messages et
médias plus récents peuvent donc être récupérés par l'administrateur. Les
projets Git et les caches OAuth sont en dehors de ces instantanés et ne sont
pas remplacés. Les archives de restauration sont protégées dans
`/var/lib/pupitre-control`, hors de portée du compte agent.

Après confirmation, le redémarrage systemd et le retour manuel restent
disponibles. Le système ne restaure pas automatiquement un ancien instantané
plusieurs jours après une confirmation : cela remplacerait les données récentes
sans intervention. Les versions et instantanés ne sont pas purgés automatiquement.
La préparation refuse de démarrer quand moins de 3 Gio restent libres.

Une panne totale du VPS, du système ou de Tailscale nécessite SSH ou la console
OVH. Les sauvegardes sur ce même serveur ne couvrent pas sa perte totale.

### Installer le secours sur cette architecture

L'installation initiale est une opération administrateur ; une mise à jour
normale de Pupitre ne réinstalle **jamais** le secours.

```bash
sudo bash scripts/server/control/install.sh \
  vps-139a77b3.tailfd41cd.ts.net clement.serizay@gmail.com
```

Dans la console, préparer et ouvrir la version de référence, puis initialiser
la bascule vers les versions protégées :

```bash
sudo python3 /opt/pupitre-control/bootstrap.py
sudo systemctl status pupitre-control pupitre pupitre-web
```

`bootstrap.py` conserve l'ancien service et l'ancienne interface, et les rétablit
si cette première migration échoue. Les unités preview/build n'agissent que sur
leurs propres comptes. La production des autres applications et la stable du
PC ne sont pas modifiées. Le port 4820 du PC reste réservé à sa stable et
`bun run promote` reste exclusivement le parcours de promotion du bureau.

```bash
python3 -m unittest discover -s scripts/server/control -v
sudo journalctl -u pupitre-control -u pupitre-build -n 50
```

Pour retirer l'accès web, exécuter `sudo tailscale serve --https=443 off` et
arrêter `pupitre-web`. Les projets et conversations restent sur le disque.

Références : [Tailscale Serve et identité](https://tailscale.com/docs/features/tailscale-serve#identity-headers),
[authentification Codex sur un serveur](https://learn.chatgpt.com/docs/auth).
