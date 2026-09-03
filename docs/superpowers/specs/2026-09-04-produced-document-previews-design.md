# Aperçus et édition des documents produits

**Date :** 2026-09-04
**Statut :** conception validée, à relire avant planification

## Problème

Pupitre sait déjà conserver et afficher les HTML et PDF publiés par l’outil MCP
`publish_document`. Pourtant, le préambule injecté dans chaque tour demande encore à
l’agent de fournir un lien vers le fichier créé. Un lien Markdown local n’émet aucun
événement `document-ref` : il n’affiche donc ni carte inline ni pièce jointe dans le
tiroir de la conversation.

Les liens Markdown ordinaires ont un second défaut indépendant : contrairement aux
liens du dashboard, ils ne passent pas par `ExternalLink`. Une URL web remplace alors
la vue Pupitre au lieu d’être ouverte par le navigateur système.

## Résultat attendu

Tout fichier produit par un agent est publié comme artefact natif de la conversation.
Il apparaît dans le fil et dans le tiroir de pièces jointes, avec le meilleur aperçu
disponible. Les documents éditables modifient la copie durable conservée par Pupitre.

| Format | Aperçu inline | Modification | Ouverture externe |
|---|---|---|---|
| HTML | iframe sandboxée, scrollable | source et aperçu live | Chrome |
| PDF | lecteur PDF | lecture seule | lecteur PDF système |
| CSV / TSV | grille scrollable | grille native, sauvegarde automatique | tableur système |
| XLSX | grille par feuille | grille native, sauvegarde automatique | LibreOffice Calc |
| Markdown | rendu et source | source et aperçu live | éditeur système |
| TXT | texte | éditeur inline | éditeur système |
| JSON | arbre/texte formaté | éditeur inline validé | éditeur système |
| DOCX | rendu PDF généré | LibreOffice Writer | LibreOffice Writer |
| Autre format autorisé | carte sans aperçu | externe uniquement | application système |

Le plein écran est disponible pour tous les aperçus inline. Le téléchargement restitue
toujours la dernière version enregistrée.

## Architecture retenue

### 1. Un artefact générique

Le service actuellement nommé `HtmlDocumentService` devient un service de documents
produits, tout en conservant les routes `/api/documents` et la compatibilité des anciens
événements `html-document-ref`. Les nouveaux événements utilisent `document-ref` et un
`kind` étendu :

`html | pdf | csv | tsv | xlsx | markdown | text | json | docx | file`.

Chaque artefact possède :

- un original durable dans le répertoire de données Pupitre ;
- son nom, son MIME, sa taille, son hash et un numéro de révision ;
- éventuellement un dérivé d’aperçu (PDF, HTML ou miniature) ;
- du texte indexable extrait de la dernière révision.

La publication reste limitée aux fichiers situés dans le projet ou dans le répertoire
temporaire autorisé. Le type est déterminé à partir de l’extension puis validé par la
signature ou le décodage du contenu ; le MIME fourni par l’agent n’est jamais considéré
comme une preuve.

### 2. Publication par l’agent

Le préambule de tour demande explicitement d’appeler `publish_document` pour chaque
fichier livré et précise qu’un lien local n’est pas une livraison Pupitre. La description
et le schéma de l’outil MCP annoncent les formats acceptés et leurs limites.

L’outil accepte une publication par appel. Plusieurs fichiers produits donnent plusieurs
événements et plusieurs éléments dans le tiroir. Cette règle évite les archives opaques
et conserve un aperçu/action par fichier.

### 3. Aperçus

- HTML : contenu original servi avec jeton court et iframe `sandbox` existante.
- PDF : contenu original dans le lecteur du navigateur.
- CSV/TSV : parsing côté client avec détection du séparateur, ligne d’en-tête et zone
  scrollable virtualisable. Les cellules restent du texte ; aucune formule n’est exécutée.
- XLSX : lecture et écriture via une bibliothèque dédiée. Les feuilles sont sélectionnables
  et rendues dans la même grille. Une édition de cellule préserve les feuilles, formules
  et styles non touchés autant que le permet la bibliothèque ; la fidélité parfaite à
  Excel n’est pas promise.
- Markdown/TXT/JSON : éditeur texte et aperçu adapté. JSON invalide reste modifiable mais
  ne peut pas être enregistré avant correction.
- DOCX : conversion isolée en PDF par LibreOffice headless. Le dérivé ne remplace jamais
  l’original et peut être régénéré.
- Format générique : aucune tentative de rendu actif.

Les contenus actifs sont servis avec des en-têtes restrictifs. Aucun document n’obtient
un accès au contexte ou au stockage de la fenêtre Pupitre.

### 4. Écriture et concurrence

Les modifications inline passent par une route `PUT /api/documents/:id/content` avec
le numéro de révision lu par le client. Le sidecar écrit dans un fichier temporaire du
même dossier, puis effectue un renommage atomique. Il recalcule taille/hash/révision,
invalide les dérivés, réindexe le texte et diffuse un événement de mise à jour.

L’éditeur sauvegarde après une courte temporisation et affiche explicitement les états
« modifications », « enregistrement », « enregistré » et « conflit ». Si la révision
a changé entre lecture et écriture, le serveur répond `409` et n’écrase rien.

### 5. DOCX et applications système

Le bouton « Modifier dans LibreOffice » ouvre l’original durable avec le plugin Tauri
opener. Le sidecar surveille uniquement les documents ouverts depuis Pupitre. Lorsqu’un
changement de taille/date se stabilise, il relit le fichier, valide qu’il reste un DOCX,
met à jour sa révision, puis régénère l’aperçu PDF et la miniature. Le client recharge le
dérivé grâce au numéro de révision.

Le watcher est arrêté à la fermeture du sidecar ou après une période d’inactivité. Un
bouton « Actualiser » reste disponible si le système de fichiers ne signale pas une
modification. L’absence de LibreOffice produit une erreur actionnable et conserve le
téléchargement ; elle ne rend pas le document indisponible.

Les autres boutons d’ouverture externe utilisent l’application associée par le système.
Les URL `http://` et `https://` rendues dans le Markdown utilisent `ExternalLink` et sont
donc ouvertes dans Chrome ou le navigateur système, jamais dans la WebView Pupitre.
Les ancres internes (`#…`) restent gérées dans Pupitre. Les schémas non autorisés sont
refusés.

## Interface

La carte existante devient `DocumentCard` et conserve son comportement : dernier document
ouvert automatiquement, aperçu scrollable, réduction et plein écran. Elle ajoute selon le
format :

- un sélecteur de mode « Aperçu / Modifier » pour les formats éditables ;
- un sélecteur de feuille pour XLSX ;
- un état de sauvegarde non bloquant ;
- « Modifier dans LibreOffice » pour DOCX ;
- « Ouvrir avec… » et « Télécharger » quand ils sont pertinents.

Le tiroir en haut à droite compte chaque `document-ref`, affiche sa miniature et ouvre la
carte correspondante plutôt qu’un simple agrandissement d’image.

## API et données

La table `documents` reçoit au minimum `revision`, `preview_mime_type`,
`preview_relative_path` et `source_modified_at`. La migration fournit des valeurs par
défaut aux HTML/PDF existants. Les types TypeScript backend/frontend partagent la liste
des formats acceptés afin d’éviter les divergences de rendu.

Nouvelles opérations :

- lire le contenu éditable ou le modèle tabulaire d’un document ;
- enregistrer une révision avec contrôle optimiste ;
- servir le dérivé d’aperçu avec jeton ;
- ouvrir l’original avec l’application système ;
- demander une régénération manuelle du dérivé.

Les routes de lecture actuelles restent compatibles. Les anciens HTML/PDF continuent à
s’afficher sans migration de fichier.

## Limites et sécurité

- Les limites de taille sont définies par famille ; les fichiers bureautiques restent
  bornés à la limite actuelle des pièces jointes, sauf configuration explicite.
- Les ZIP arbitraires ne sont jamais extraits. DOCX/XLSX sont inspectés comme conteneurs
  ZIP avec protections contre traversée de chemin et décompression excessive.
- Les macros et formats macro-enabled ne sont pas acceptés dans cette première version.
- Les formules XLSX sont conservées mais jamais exécutées par Pupitre.
- L’édition DOCX reste volontairement confiée à LibreOffice pour préserver la fidélité.
- Une conversion LibreOffice est lancée sans réseau, dans un profil temporaire distinct,
  avec délai maximal et nettoyage garanti.

## Tests et validation

### Sidecar

- publication et validation de chaque format ;
- refus des extensions, signatures, tailles et conteneurs dangereux ;
- migration et lecture des anciens documents ;
- sauvegarde atomique, incrément de révision et conflit `409` ;
- extraction/indexation ;
- conversion DOCX et comportement sans LibreOffice ;
- détection d’une modification externe et diffusion de la nouvelle révision ;
- préambule exigeant `publish_document` et interdisant le simple lien local.

### UI

- les liens web Markdown passent par `ExternalLink` ;
- chaque format sélectionne le bon aperçu et les bonnes actions ;
- édition, autosauvegarde, erreur et conflit ;
- navigation entre feuilles XLSX ;
- rechargement DOCX après une nouvelle révision ;
- compteur et contenu du tiroir pour tous les documents ;
- plein écran, clavier et attributs de sandbox.

### Vérification réelle

Après les suites `sidecar` et `ui`, la version dev sera testée sur
`http://localhost:5173` avec un jeu produit comprenant HTML, CSV, XLSX et DOCX. La
validation mesurera dans le DOM la présence des cartes, du compteur, des cellules et de
l’iframe, puis vérifiera l’ouverture externe et le rafraîchissement DOCX. Une capture du
résultat sera jointe à la livraison.

## Hors périmètre

- édition native riche de DOCX ;
- édition de PDF ;
- compatibilité macros VBA ;
- collaboration simultanée multi-utilisateur ;
- aperçu spécialisé des archives, présentations et médias non déjà pris en charge.
