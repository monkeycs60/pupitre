# Jeu pirate — v1 (solo d'abord)

Jeu d'action pirate en 3D, à la troisième personne : on passe sans coupure du pont à la barre, de la bordée de canons au combat au sabre. Une sortie dure environ 15 minutes et finit par un achat au port.

Ce dépôt contient une **version web jouable** (Three.js) du document « Cadre v1 — Jeu pirate (solo d'abord) » du 10 novembre 2026. Elle tourne au tactile sur téléphone et au clavier/souris sur ordinateur.

> Cette branche est indépendante du reste du dépôt qui l'héberge : elle n'a aucun historique commun avec lui et ne contient que le jeu. Voir « Déplacer vers un dépôt dédié » en fin de page.

## Sommaire

1. [État d'avancement](#état-davancement)
2. [Prochaines étapes](#prochaines-étapes)
3. [Conformité au cadre](#conformité-au-cadre)
4. [Ce que fait le jeu](#ce-que-fait-le-jeu)
5. [Valeurs d'équilibrage](#valeurs-déquilibrage)
6. [Ce qui a été testé](#ce-qui-a-été-testé)
7. [Limites connues](#limites-connues)
8. [Lancer, construire, tester](#lancer-construire-tester)
9. [Commandes](#commandes)
10. [Organisation du code](#organisation-du-code)
11. [Ajouter du contenu](#ajouter-du-contenu)
12. [Modèles Tripo](#modèles-tripo)
13. [Déplacer vers un dépôt dédié](#déplacer-vers-un-dépôt-dédié)

## État d'avancement

Mis à jour le 10 novembre 2026.

Le cadre dit qu'un jalon n'est fini que lorsque son test de plaisir passe, manette en main. **Aucun de ces tests n'a encore été fait par un joueur** : le tableau sépare donc ce qui est écrit de ce qui est validé.

| Jalon | Contenu demandé | Écrit | Test du jalon |
|---|---|---|---|
| 0 · Socle et pipeline | Projet Unreal, pirate Tripo riggé, navire importé | Non : socle web à la place, modèles procéduraux | « Un pirate généré court sur le pont » : pas fait |
| 1 · À pied | Sabre, mousquet, esquive, un premier ennemi | Oui | « Un combat contre trois ennemis donne envie de recommencer » : à jouer |
| 2 · La barre et la mer | Prise de barre, navigation, canons, dégâts par zone, un sloop ennemi | Oui | « Couler un navire ennemi est satisfaisant » : à jouer |
| 3 · La boucle | Port, île, butin, améliorations, niveaux, sauvegarde | Oui | « Une sortie de 15 minutes se rejoue avec plaisir » : à jouer |
| 4 · Contenu de la v1 | Seconde île, fort et boss, primes, équilibrage, son | Oui, sauf équilibrage (premier jet) et musique (absente) | « Deux heures de jeu sans lassitude » : à jouer |

En résumé : tout le périmètre « Dans la v1 » du cadre est codé et s'enchaîne sans erreur dans des tests scriptés. Il manque les modèles Tripo, l'équilibrage, et surtout le verdict d'un joueur.

## Prochaines étapes

Par ordre de priorité.

### 1. Jouer et juger (bloque tout le reste)

- [ ] Faire une vraie sortie de 15 minutes sur téléphone et sur ordinateur, puis passer les quatre tests de plaisir des jalons 1 à 4.
- [ ] Noter ce qui casse ou ennuie : c'est cette liste qui doit piloter l'équilibrage, pas l'inverse.
- [ ] Vérifier sur appareil réel ce que les tests scriptés ne voient pas : fluidité (la résolution s'adapte seule, réglage Qualité dans la pause), son, manette, plein écran et verrouillage en paysage, chargement de Three.js depuis le CDN.

### 2. Équilibrage

Tout se règle dans `src/config.js`, sans toucher aux systèmes.

- [ ] Durée réelle d'une sortie par rapport aux 15 minutes visées (distances entre îles, vitesse du sloop).
- [ ] Courbe d'expérience et or gagné par sortie par rapport au prix des améliorations.
- [ ] Difficulté des trois îles et du capitaine au niveau conseillé (5).
- [ ] Dilemme du colmatage : vitesse de réparation et débit des voies d'eau.
- [ ] Décider si la parade reste débloquée au niveau 2 ou fait partie du kit de départ (le cadre la cite aux deux endroits).

### 3. Pipeline Tripo

- [ ] Lancer `tripo-generer.mjs` (jamais exécuté contre la vraie API, voir [Modèles Tripo](#modèles-tripo)).
- [ ] Charger des `.glb` dans le jeu : ajouter `GLTFLoader` au build. Three.js est aujourd'hui un global chargé par balise `<script>` ; il faut un alias esbuild qui renvoie `three` vers ce global, sinon le chargeur embarque une seconde copie de la bibliothèque.
- [ ] Décider où vivent les fichiers : embarqués dans la page (limite de 16 Mo pour la version publiée) ou servis à côté.
- [ ] Remplacer les décors un par un (palmier, rocher, coffre, caisse, tonneau, tente, maison, étal, phare, épave) en contrôlant échelle, orientation et matériaux après import, comme le demande le cadre.
- [ ] Pirate : rig automatique Tripo puis reciblage sur le squelette du jeu, ou repli sur le pirate procédural si les épaules se déforment mal.
- [ ] Sloop : découpe en cinq zones de coque, mâts, voiles, canons, barre. Commencer avec deux états par zone, comme le prévoit la parade du cadre.

### 4. Écarts de comportement à combler

- [ ] Tireur : le cadre veut qu'il recharge à couvert. Aujourd'hui il garde ses distances et se déplace latéralement, sans chercher d'abri.
- [ ] États des zones : aujourd'hui teinte assombrie, impacts et brèches affichés, voiles déchirées, mât supérieur retiré. De vrais modèles par état viendront avec le sloop Tripo.
- [ ] Musique et ambiance : seuls des bruitages synthétisés existent.
- [ ] Fermer l'abus du pont : amarré, on peut tirer au mousquet sur les ennemis d'une île sans qu'ils ripostent.

### 5. Décision de moteur

Le cadre fixe Unreal Engine 5.8 (C++, Gameplay Ability System, Character Movement Component) parce que le combat à pied en multijoueur exige la prédiction de mouvement qu'Unreal fournit. Cette version web ne règle pas cette question.

- [ ] Trancher : poursuivre en web, ou traiter cette version comme un prototype de règles et porter vers Unreal.
- Ce qui se reporte tel quel vers Unreal : les données de `config.js` (vers Data Assets et Data Tables), les règles de dégâts et de zones, les automates d'IA à cinq états, la boucle de progression, la carte.
- Ce qui ne se reporte pas : le rendu, le contrôleur, les animations procédurales, l'interface.

### 6. Questions ouvertes du cadre, toujours sans réponse

- [ ] Machine de développement : PC avec carte graphique dédiée, ou autre ?
- [ ] Heures par semaine, pour dater les jalons.
- [ ] Ton de l'univers : pirates historiques, ou fantastique avec squelettes et malédictions ?
- [ ] Un second port dès la v1, pour amorcer le commerce ?
- [ ] Un nom de code pour le projet.

### 7. Hygiène du projet

- [ ] Sortir cette branche dans son propre dépôt (commandes en fin de page).
- [ ] Brancher les scénarios de test dans une intégration continue.
- [ ] Passer le code en TypeScript si le projet reste en web.

Ne rien coder de la colonne « Reporté » du cadre (multi, PvP, commerce, abordage, vent, météo, monstres) tant que la v1 n'est pas validée : c'est le risque principal identifié par le cadre.

## Conformité au cadre

### Écarts assumés

| Sujet | Le cadre | Cette version | Pourquoi |
|---|---|---|---|
| Moteur | Unreal Engine 5.8, C++ et Blueprints | Three.js 0.159, JavaScript | Jouable immédiatement sur téléphone et ordinateur, sans installation |
| Style de code | Classes et héritage assumés | Fonctions et état partagé, sans classes ni `this` | Aucune contrainte de moteur n'impose l'objet ici |
| Modèles | Tripo pour tout | Procéduraux | L'API Tripo n'était pas joignable depuis l'environnement de développement |
| Animations | Squelette du Mannequin, Game Animation Sample | Squelette bipède maison, animation procédurale | Pas de moteur Unreal |
| Vagues | Décor seulement, simulation plate | Navigation sur un plan plat, mais la coque monte, tangue et roule sur la houle, et la hauteur de la coque compte pour les impacts de boulets | Demande explicite de « vagues sur la mer » |
| Test à deux joueurs par jalon | Demandé pour préparer le multi | Pas fait | Sans objet en web solo |

### Règles du cadre respectées

- Barre tenue, navire en mouvement ; barre lâchée, il ralentit et s'immobilise.
- Une seule source de vérité : dégâts de navire (`damageShip`), dégâts aux ennemis (`damageEnemy`), dégâts au joueur (`damagePlayer`), butin et expérience (`progression.js`). Rien ne se calcule dans l'interface.
- Un seul squelette pour tous les bipèdes, joueur et boss compris.
- Les données sont séparées du code (`config.js`).
- Les lieux sont des zones nommées, séparées par de la mer.
- Pas de nage ni de barque : tomber à l'eau ramène sur le pont.
- Le butin ne compte qu'une fois rentré au port.

## Ce que fait le jeu

### La mer et le navire

- Houle de Gerstner à cinq vagues, calculée à l'identique dans le shader et côté jeu ; écume sur les crêtes et au rivage, eau turquoise près des côtes, ciel avec nuages.
- Le sloop suit la houle (quatre points de mesure), gîte en virage et s'enfonce quand la coque est basse.
- Trois allures de voile, inertie, virage plus large à haute vitesse, perte de vitesse en virant.
- Amarrage : barre lâchée près d'un ponton, le navire vient se ranger seul et une passerelle relie le pont au ponton.
- Hauts-fonds : s'échouer abîme la coque. La carte est bornée par des courants.

### Le combat naval

- Bordées bâbord et tribord ; regarder d'un côté affiche l'arc de tir, qui rougit quand une cible est dans l'axe. Chaque bord recharge séparément.
- Visée de la coque ou des voiles, au choix.
- Éperonnage : dégâts selon la vitesse d'impact, appliqués à la zone touchée ; la proue de l'éperonneur encaisse une part réduite.
- Cinq zones avec leurs malus : proue (éperon inefficace), flancs (canons du bord hors service, voie d'eau), poupe (maniabilité réduite), mâts (vitesse réduite).
- Colmatage à pied, zone par zone, en consommant des planches. Lâcher la barre pour réparer arrête le navire.
- Ennemis : sloop rapide et fragile, galion lent aux bordées lourdes. Ils suivent les mêmes règles de zones, patrouillent sur des routes fixes, poursuivent, présentent le flanc, puis rentrent. Ils n'entrent pas dans la zone sûre du port.

### Le combat à pied

- Sabre : enchaînement de trois coups avec accroche de la cible la plus proche, coup lourd, parade (une parade au bon moment étourdit l'attaquant).
- Mousquet : visée à l'épaule, un tir puissant, rechargement long que l'esquive interrompt. Tir chargé qui traverse, au niveau 5.
- Roulade avec invulnérabilité brève, saut, endurance consommée par l'esquive, la parade et le coup lourd.
- Retours d'impact : arrêt sur image, tremblement de caméra, chiffres de dégâts, éclats, vignette rouge.

### Les ennemis à pied

| Ennemi | Comportement |
|---|---|
| Bretteur | Fonce, enchaîne un ou deux coups, recule |
| Tireur | Garde ses distances, vise (trait rouge annonciateur), tire, recharge |
| Brute | Coup lourd annoncé par un cercle au sol, encaisse sans broncher sauf coup lourd ou mousquet |
| Le Boucher | Mini-boss de l'Île du Crâne, brute renforcée |
| Capitaine du fort | Boss : enchaînement de trois coups au sabre, pistolet à distance, appelle des renforts à 66 % puis 33 % de vie |

IA à cinq états : repos, patrouille, poursuite, attaque, retour. Deux attaquants au contact au plus, les autres tournent autour. Les ennemis d'une île réapparaissent quand on l'a quittée.

### Le monde

| Lieu | Rôle | Contenu |
|---|---|---|
| Port-Liberté | Base sûre | Marchand, chantier naval, tableau des primes, sauvegarde à l'amarrage |
| Île aux Tortues | Zone de départ | Bretteurs et tireurs affaiblis, 3 coffres simples |
| Île du Crâne | Zone avancée | Brutes, groupes mixtes, Le Boucher, 4 coffres dont un de rang 3 |
| Fort de la Couronne | Objectif final | Galion en défense, cour gardée, capitaine, 2 coffres de rang 3 |
| 5 épaves | Butin en mer | Caisses flottantes, deux d'entre elles gardées par un sloop |
| Patrouilles | Menace en mer | 2 sloops et 1 galion sur des routes fixes ; le second galion tourne devant le fort |

Une seule carte en continu, sans écran de chargement.

### La boucle et la progression

- Port : vendre le butin à prix fixes, acheter des planches, réparer, améliorer le navire, prendre ou toucher une prime, consulter le capitaine.
- Capitaine : 10 niveaux. Chaque niveau donne de la vie, de l'endurance et des dégâts ; parade au niveau 2, coup lourd au niveau 3, tir chargé au niveau 5.
- Navire : coque, voiles, canons, cale, trois rangs chacun, payés en or et en planches.
- Primes : 8 au total, une active à la fois, 3 tirées au hasard plus celle du fort. La mini-carte pointe l'objectif quand il a un lieu précis, puis le port une fois la prime accomplie.
- Mort à pied : réveil sur le pont, le butin porté reste là où l'on est tombé.
- Navire coulé : retour au port, cargaison perdue, réparation payante, niveaux et améliorations conservés.
- Sauvegarde locale à chaque amarrage à Port-Liberté.

### Interface

- HUD dans les coins : vie, endurance, expérience, munitions, or, cale, planches, mini-carte, prime en cours, silhouette du navire avec l'état des cinq zones.
- Carte complète, pause, réglages (qualité, son, sensibilité), écran de fin.
- Mise en page tactile dédiée : joystick à gauche, boutons à droite, qui changent entre « à pied » et « à la barre ».

## Valeurs d'équilibrage

Premier jet, toutes dans `src/config.js`.

### Navires

| | Coque | Vie par zone | Vitesse max | Canons par bord | Dégâts par boulet | Recharge | XP |
|---|---|---|---|---|---|---|---|
| Sloop du joueur | 300 | 100 | 13,5 m/s | 4 | 22 | 4,5 s | |
| Sloop ennemi | 190 | 70 | 11,5 m/s | 3 | 11 | 6,5 s | 60 |
| Galion ennemi | 600 | 150 | 8,2 m/s | 6 | 15 | 8 s | 160 |

Autres règles (dans `ship.js`) : un flanc détruit fait perdre 4,5 points de coque par seconde au joueur ; mâts détruits, vitesse × 0,42 ; poupe détruite, maniabilité × 0,38 ; proue détruite, éperon × 0,25. Colmater rend 16 points par seconde et coûte une planche pour 12 points ; une zone détruite redevient active à 30 %.

### Joueur

| | Valeur |
|---|---|
| Vie / endurance de départ | 100 / 100, puis +10 et +6 par niveau |
| Sabre | 18, 18, 28 ; coup lourd 48 (26 d'endurance) |
| Mousquet | 70 ; tir chargé 125 après 1,3 s de visée ; recharge 2,5 s ; 8 balles |
| Roulade | 22 d'endurance, 0,42 s d'invulnérabilité |
| Parade | 7 d'endurance par seconde, 18 par coup bloqué ; fenêtre parfaite de 0,28 s |
| Dégâts | +5 % par niveau |
| Seuils de niveau (XP) | 40, 110, 220, 380, 600, 900, 1 300, 1 800, 2 400 |

### Ennemis à pied

| | Vie | Vitesse | Dégâts | XP |
|---|---|---|---|---|
| Bretteur | 55 | 5,2 m/s | 11 | 12 |
| Tireur | 40 | 4,2 m/s | 18 | 14 |
| Brute | 170 | 3,1 m/s | 34 | 30 |
| Le Boucher | 380 | 3,3 m/s | 40 | 120 |
| Capitaine du fort | 760 | 4,6 m/s | 15 au sabre, 22 au pistolet | 400 |

Sur l'Île aux Tortues, vie, dégâts et expérience sont multipliés par 0,7.

### Économie

| Butin | Prix |
|---|---|
| Rhum | 15 |
| Épices | 30 |
| Soieries | 50 |
| Perles | 90 |
| Idole d'or | 220 |

| Rang d'amélioration | Or | Planches |
|---|---|---|
| 1 | 150 | 6 |
| 2 | 400 | 14 |
| 3 | 900 | 28 |

Coque +25, +50, +80 % ; voiles +10, +20, +30 % ; canons +20, +40, +65 % de dégâts ; cale 12 puis 18, 26, 36 emplacements. Planche : 10 or. Primes : de 100 à 320 or, 1 000 pour le fort.

## Ce qui a été testé

Tests pilotés par script dans un Chrome sans carte graphique (rendu logiciel), sans erreur de console :

- marcher du port au ponton, monter à bord par la passerelle, prendre la barre, hisser les voiles, virer ;
- duel de bordées contre un sloop jusqu'au naufrage, épaves, prime accomplie ;
- accoster une île, lâcher la barre, descendre par la passerelle ;
- combat à terre sur les trois îles, mousquet, esquive, parade, coup lourd, coffres ;
- mort à pied, naufrage, colmatage ;
- fort : renforts du capitaine, mort du boss, écran de fin ;
- 16 minutes de patrouilles ennemies sans échouage ni blocage ;
- menus du port, carte, pause, changement de qualité, retour à l'écran titre ;
- mise en page tactile en paysage (915 × 412) et en portrait (412 × 915).

Ces tests avancent la simulation par à-coups et téléportent souvent le joueur : ils prouvent que les systèmes s'enchaînent, pas que le jeu est agréable ni bien réglé.

**Pas vérifié :** la fluidité sur un vrai téléphone (le rendu logiciel du test tourne à 3 images par seconde, ce qui ne dit rien), le son, la manette, le plein écran, le chargement depuis le CDN, et `tripo-generer.mjs` contre la vraie API.

## Limites connues

- Sauvegarde dans le stockage local du navigateur : elle ne suit pas d'un appareil à l'autre et disparaît si les données du site sont effacées.
- Les ennemis à pied n'ont pas de recherche de chemin : ligne droite et évitement par cercles, avec un passage par la porte codé pour le fort seulement. Ils peuvent se bloquer derrière un décor.
- Les ennemis à pied ne montent pas à bord. Le pont est donc une zone sûre, d'où l'abus du mousquet cité plus haut.
- Les navires ennemis s'évitent mal entre eux ; leur évitement des côtes repose sur trois sondes devant la proue.
- Si la souris ne peut pas être capturée (page intégrée dans un cadre), il faut maintenir un bouton pour regarder ; le clic gauche fait alors aussi attaquer.
- `WORLD.wind` existe dans la configuration mais ne sert à rien : le vent tactique est dans la colonne « Reporté ».

## Lancer, construire, tester

Node 18 ou plus.

```bash
npm install
npm run build      # dist/jeu-pirate.html et dist/local.html, minifiés
npm run dev        # idem, non minifié
```

- `dist/local.html` s'ouvre directement dans un navigateur, sans serveur (Three.js est copié dans `dist/three.min.js`).
- `dist/jeu-pirate.html` est la version publiée : un fragment HTML, sans `<html>` ni `<body>`, qui charge Three.js 0.159 depuis jsDelivr.

Tests scriptés, avec Playwright et un Chrome installé :

```bash
npm install --no-save playwright
CHROME=/chemin/vers/chrome node test/run.mjs <scénario> [largeur] [hauteur] [tactile 0|1]
```

Scénarios : `title`, `start`, `board`, `sail`, `naval`, `fight`, `ui`, `mobile`, `smoke`, `boss`, `boss2`, `moor`, `misc`, `gal`. Les captures vont dans `shots/`. Le jeu expose `window.__pirate` (état, progression, `sim(n)` pour avancer de n pas) à l'usage des tests.

## Commandes

| | Clavier et souris | Tactile |
|---|---|---|
| Se déplacer / gouverner | ZQSD (lu par position : WASD en QWERTY) | pouce gauche |
| Regarder | souris | glisser à droite |
| Sabre / bordée | clic (à la barre : bordée du côté regardé) | Sabre, Bâbord, Tribord |
| Mousquet | clic droit pour viser, clic pour tirer | maintenir Tir, relâcher |
| Esquive, saut | Maj, Espace | Esquive, Saut |
| Parade (niv. 2), coup lourd (niv. 3) | A (position Q), F | Parade, Lourd |
| Interagir, colmater, ouvrir un coffre | E (maintenir) | bouton contextuel |
| Voiles | Z / S à la barre | ▲ ▼ |
| Viser coque ou voiles | R | Coque / Voiles |
| Carte, pause | , (position M) ou Tab, Échap | mini-carte, II |

Une manette au standard « Gamepad » est prise en charge dans le code, sans avoir été essayée. Au tactile et à la manette, la visée s'accroche à l'ennemi le plus proche.

## Organisation du code

Environ 3 500 lignes de JavaScript réparties en 19 modules, sans classes ni `this` : des fonctions, un état partagé (`G` dans `state.js`) et un petit bus d'événements (`on` / `emit`).

| Module | Rôle | Équivalent dans le cadre |
|---|---|---|
| `config.js` | Toutes les données : navires, ennemis, butin, améliorations, primes, carte, flotte | Noyau (données) |
| `state.js` | État de la partie, bus d'événements | Noyau |
| `progression.js` | Butin, expérience, primes, port, mort, naufrage, sauvegarde | Noyau (règles, sauvegarde) |
| `player.js` | Contrôleur du pirate, actions, dégâts reçus | Personnage |
| `charmodel.js` | Squelette bipède unique, animation procédurale | Personnage |
| `ship.js` | Physique, zones, canons, éperonnage, amarrage, IA navale | Navire, Combat, IA |
| `shipmodel.js` | Modèle du navire, états visuels des zones | Navire |
| `enemies.js` | IA à pied, boss, projectiles | IA, Combat |
| `world.js` | Îles, pontons, décors, collisions, coffres, épaves, butin | Monde |
| `ocean.js` | Houle partagée entre shader et jeu, ciel | Monde |
| `hud.js` | Interface, menus, carte | Interface |
| `input.js`, `camera.js` | Clavier, souris, tactile, manette ; caméra | Interface |
| `fx.js`, `audio.js` | Particules et effets ; sons synthétisés | |
| `geo.js`, `util.js`, `three.js` | Fusion de maillages, maths, accès à Three.js | |
| `main.js` | Démarrage, boucle de jeu, résolution adaptative | |

`template.html` contient la page et tout le CSS ; `build.mjs` y injecte le code compilé par esbuild.

## Ajouter du contenu

Tout passe par `src/config.js` :

- **Un ennemi** : une ligne dans `FOES` (vie, vitesse, dégâts, arme `saber`, `musket` ou `club`, couleurs), puis son nom dans la liste `foes` d'un camp.
- **Un camp ou un coffre** : dans l'île concernée d'`ISLANDS`. `af` est la position vers le ponton en fraction du rayon, `ac` l'écart latéral en mètres.
- **Une île** : une entrée dans `ISLANDS` (position, rayon, relief, direction du ponton). Le terrain, le ponton, la carte et le rivage en découlent.
- **Un navire ennemi** : une ligne dans `FLEET`, avec une route à plusieurs points (patrouille) ou un seul (poste fixe).
- **Une prime** : une ligne dans `BOUNTIES`, branchée sur un événement existant (`kill`, `sunk`, `cleared`, `chest`, `wreck`).
- **Un butin** : `LOOT` pour le prix, `DROPS` pour les tables.

## Modèles Tripo

```bash
TRIPO_API_KEY=tsk_... node tripo-generer.mjs            # les 12 modèles
TRIPO_API_KEY=tsk_... node tripo-generer.mjs palmier coffre
```

- Écrit d'après la documentation v3 de Tripo (`openapi.tripo3d.com`) et vérifié seulement contre un faux serveur local : création, suivi, échec, reprise.
- Un seul texte de style commun à tous les modèles, pour tenir la cohérence demandée par le cadre.
- Génération légère avec cible de polygones, de 1 000 triangles (caisse) à 16 000 (sloop).
- Les fichiers déjà présents dans `assets/` sont conservés ; une tâche interrompue est reprise au lieu d'être relancée et refacturée.
- La clé se passe en variable d'environnement et ne doit jamais être écrite dans le dépôt. `assets/` est ignoré par git.

## Déplacer vers un dépôt dédié

Cette branche est orpheline : elle se pousse telle quelle dans un dépôt vide.

```bash
git clone --single-branch --branch jeu-pirate https://github.com/monkeycs60/pupitre jeu-pirate
cd jeu-pirate
git remote set-url origin https://github.com/monkeycs60/jeu-pirate
git push -u origin jeu-pirate:main
```

La branche peut ensuite être supprimée ici : `git push https://github.com/monkeycs60/pupitre --delete jeu-pirate`.
