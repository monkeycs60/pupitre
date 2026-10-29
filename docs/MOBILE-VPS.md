# Modifier et mettre à jour Pupitre depuis le S26

Cette procédure concerne **Pupitre installé sur le VPS personnel**, accessible
depuis le navigateur du S26. Le PC peut être éteint. Le parcours de déploiement
des autres projets reste propre à chacun de ces projets.

## La phrase à utiliser

> Améliore Pupitre pour [objectif], teste, commit et push sur la branche de travail, puis prépare le passage de relais pour la promotion VPS depuis le S26. Donne le commit attendu et le lien du secours.

La formulation courte « commit, push et promote » convient aussi : l'agent doit
l'interpréter selon ce guide et laisser les boutons du secours à Clément.

## Ce qui est automatique et ce qui reste sur le téléphone

| Demande | Action de l'agent du VPS | Action de Clément |
| --- | --- | --- |
| Modifier et tester | Modifier le projet et lancer les contrôles pertinents | Expliquer le résultat souhaité |
| Commit | Enregistrer les fichiers concernés dans Git et relever le SHA | Aucune après la demande |
| Push | Si explicitement demandé, publier la branche sur GitHub et vérifier la réussite | Aucune après la demande |
| Promote / mettre en service | Vérifier le dépôt source et donner le lien du secours et le SHA attendu | Préparer, tester, appliquer et confirmer dans le secours |
| Avancer develop | Si demandé après confirmation, pousser `feat/vps-web` puis avancer `develop` en avance rapide, et vérifier les deux SHA sur GitHub | Confirmer la version sur le S26, puis le demander |

Le dépôt GitHub `monkeycs60/pupitre` est public. Un push publie le code sur ce
dépôt ; il ne remplace pas l'application en service. Aucun identifiant ni fichier
personnel ne doit entrer dans le commit.

## Branches

- `feat/vps-web` est la branche de travail du VPS. Le dépôt
  `/home/pupitre/projects/pupitre` reste dessus : « Préparer la version »
  construit son HEAD. Dans « Nouvelle conversation », laisser la branche cible
  sur `feat/vps-web` : l'agent travaille alors directement dans ce dépôt.
- Une autre branche cible crée un worktree séparé. Son travail n'est construit
  qu'après intégration dans `feat/vps-web` (consigne 4) : à réserver aux essais
  en parallèle.
- `develop` est partagée avec le PC, les autres contributeurs et la CI. Elle ne
  reçoit que des versions confirmées sur le S26 : `feat/vps-web` sert de sas.
  Après confirmation, et sur demande, l'agent avance `develop` avec
  `git push origin feat/vps-web:develop`. Git refuse ce push si `develop` a
  divergé : ne jamais forcer.
- Si `develop` a avancé ailleurs, l'agent l'intègre dans `feat/vps-web` avant
  une nouvelle série, par avance rapide (`git merge --ff-only origin/develop`)
  ou, en cas de divergence, par une fusion validée avec Clément. La promotion
  suivante fait passer ce travail par les tests du secours.
- `master` n'avance qu'à une release de `develop`, décidée par Clément.

## Tuto éclair sur le S26

1. Activer Tailscale avec le compte personnel, puis ouvrir
   [Pupitre VPS](https://vps-139a77b3.tailfd41cd.ts.net/).
2. Choisir le projet **pupitre**, formuler le changement et attendre la fin du
   travail de l'agent. Les autres agents doivent avoir fini avant l'application.
3. Ouvrir l'icône **Mises à jour et secours** de la barre supérieure, ou son
   [favori direct](https://vps-139a77b3.tailfd41cd.ts.net:8443/).
4. Toucher **Préparer la version**, attendre la fin des contrôles, puis comparer
   le commit affiché à celui annoncé par l'agent.
5. Toucher **Ouvrir le test** et vérifier l'interface. Cette copie est isolée des
   échanges réels : les connexions Claude et Codex n'y sont pas copiées.
6. Revenir au secours et toucher **Appliquer la version**. Ouvrir Pupitre et
   vérifier le fonctionnement de la nouvelle version.
7. Revenir au secours, cocher la vérification et toucher **Confirmer cette
   version** sous **trois minutes**. Éviter de lancer une tâche longue avant
   confirmation.

Sans confirmation, ou si le démarrage échoue, le secours restaure la version
précédente automatiquement. Il est indépendant de Pupitre et reste accessible
si l'application affiche un écran vide.

## Consignes obligatoires pour l'agent

1. Lire ce guide avant une demande de mise à jour de Pupitre sur le VPS. Le
   compte de travail est `pupitre`, sans sudo. Les consignes du bureau sur le
   port 4821 et `bun run promote` ne décrivent pas le parcours serveur.
2. Travailler dans le projet ou le worktree de la conversation. Préserver les
   changements des autres conversations ; commiter uniquement le périmètre
   demandé, après les contrôles adaptés. Une modification purement documentaire
   ne nécessite pas de reconstruire ou redémarrer l'application.
3. Si un push est demandé, vérifier la branche et le remote avant publication.
   Pour une branche sans upstream, utiliser `git push -u origin HEAD`. Ne pas
   pousser de force. Vérifier la réussite ; un échec de push ne doit pas être
   présenté comme un succès. Ne pas ajouter un push à une simple demande de commit.
4. La console construit exactement le **HEAD du dépôt
   `/home/pupitre/projects/pupitre`**, sans lire automatiquement la dernière
   version de GitHub. Vérifier son SHA et sa propreté. Si le travail a été fait
   dans un autre worktree, intégrer le commit dans ce dépôt source sans perdre
   d'autres changements ; une avance rapide avec `git merge --ff-only` convient
   lorsque les historiques le permettent. Ne pas utiliser de reset ou de
   checkout forcé pour contourner un écart. Vérifier ensuite le SHA exact.
5. Terminer le tour et donner à Clément le SHA attendu, le résultat réel du
   push, le lien du secours et les boutons à toucher. L'agent encore actif peut
   bloquer l'application : ne pas attendre que Clément applique pendant ce tour.
6. Ne lancer ni `bun run promote`, ni la mission de promotion du bureau, ni un
   redémarrage direct du service pour promouvoir depuis le VPS. Ne modifier ni
   les unités administrateur, ni les versions gelées, ni le secours. Ses appels
   depuis le VPS sont refusés ; ne pas tenter de contourner ce contrôle ou de
   confirmer une mise à jour à la place de Clément.
7. N'annoncer « nouvelle version en service » qu'après confirmation et contrôle
   de santé de cette version. Un commit, un push ou un aperçu sain ne suffit pas.
8. Suivre la section Branches : commiter sur `feat/vps-web`, jamais sur
   `develop` ni `master`. N'avancer `develop` jusqu'à `feat/vps-web` qu'après
   confirmation sur le S26 et à la demande de Clément ; ne toucher à `master`
   que pour une release qu'il a décidée.

Exemple de passage de relais après une demande de push :

> Commit `<SHA>` créé et push vérifié sur `<branche>`. Le dépôt source du VPS est propre et pointe sur ce commit. Ouvrir le secours, puis Préparer la version → Ouvrir le test → Appliquer la version → Confirmer sous trois minutes après vérification. La nouvelle version n'est pas encore en service.

## Si une mise à jour pose problème

- Avant confirmation : laisser le délai expirer ou annuler dans le secours.
- Après confirmation : ouvrir le favori du secours et choisir **Restaurer la
  précédente**. Le secours avancé permet un arrêt forcé si l'état des agents
  est impossible à vérifier.
- Une restauration remet les conversations à la date de l'instantané pris
  avant mise à jour. Les données plus récentes restent conservées à part sur
  le VPS et peuvent être récupérées ; elles ne réapparaissent pas automatiquement.
- Les projets Git et les caches OAuth ne sont pas remplacés. Une restauration
  de Pupitre n'annule donc pas les commits ou le push sur GitHub.
- Une panne totale du VPS ou de Tailscale relève de SSH ou de la console OVH.

Les détails administrateur, l'installation du secours et les limites des
sauvegardes sont dans [docs/SERVER.md](SERVER.md).
