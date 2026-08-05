# Design system Pupitre — cockpit dense

Direction validée le 2026-08-05 : **cockpit dense**, dans l'esprit Linear / Zed.
Graphite quasi monochrome, un seul accent, hiérarchie par contraste et densité
plutôt que par bordures et cartes. L'app est sombre uniquement.

Ce document fait foi : aucune couleur, aucun rayon, aucune taille de texte ne
doit être écrite en dur dans un composant ou une feuille de style. Tout passe par
les tokens ci-dessous.

## Principes

1. **Le contraste porte la hiérarchie.** Un titre se distingue par sa couleur et
   son poids, pas par une bordure ou un fond. Les bordures sont des filets, pas
   des cadres.
2. **Une seule couleur d'accent**, réservée à l'état actif, au focus et aux
   actions primaires. Les couleurs sémantiques (rouge/ambre/vert) ne servent
   qu'au sens : sévérité Gardien, diff, statut de tour.
3. **Élévation par la valeur, pas par l'ombre.** Une surface au-dessus d'une
   autre est plus claire d'un cran. Les ombres portées sont réservées aux
   éléments réellement flottants (dialogs, menus, lightbox).
4. **Densité.** C'est un outil qu'on regarde des heures : lignes de 28-30 px dans
   la sidebar, en-têtes de 44-48 px, pas d'espacement décoratif.
5. **Les chiffres et les identifiants sont monospace** et en `tabular-nums` :
   SHA, compteurs, tokens, numéros de ligne, durées.

## Tokens

Déclarés une seule fois dans `ui/src/styles/tokens.css`, sur `:root`.

### Surfaces

| Token | Valeur | Usage |
| --- | --- | --- |
| `--bg-app` | `#0b0c0e` | fond de l'application, zone derrière tout |
| `--bg-panel` | `#101114` | sidebar, panneaux latéraux, titlebar |
| `--bg-raised` | `#16171b` | cartes, en-têtes collants, lignes sélectionnées |
| `--bg-overlay` | `#1b1d22` | dialogs, menus, popovers |
| `--bg-input` | `#141519` | champs de saisie, zones de code |
| `--bg-hover` | `rgba(255,255,255,0.04)` | survol d'une ligne ou d'un bouton discret |
| `--bg-active` | `rgba(255,255,255,0.07)` | ligne sélectionnée, onglet actif |
| `--scrim` | `rgba(6,7,9,0.72)` | voile derrière un dialog |

### Filets

| Token | Valeur | Usage |
| --- | --- | --- |
| `--border-subtle` | `rgba(255,255,255,0.06)` | séparations internes, lignes de tableau |
| `--border` | `rgba(255,255,255,0.10)` | contour de carte, de champ, de bouton |
| `--border-strong` | `rgba(255,255,255,0.18)` | contour au survol, séparation structurante |

### Texte

| Token | Valeur | Contraste sur `--bg-panel` | Usage |
| --- | --- | --- | --- |
| `--text` | `#e7e9ee` | 15:1 | corps, valeurs, contenu |
| `--text-strong` | `#f6f7fa` | 17:1 | titres, nombres mis en avant |
| `--text-muted` | `#9ba3b0` | 7:1 | métadonnées, libellés secondaires |
| `--text-faint` | `#727b88` | 4.6:1 | texte décoratif uniquement, jamais une information seule |

### Accent et sémantique

| Token | Valeur | Usage |
| --- | --- | --- |
| `--accent` | `#6e7bff` | état actif, action primaire, focus |
| `--accent-hover` | `#8590ff` | survol d'une action primaire |
| `--accent-soft` | `rgba(110,123,255,0.14)` | fond d'un état actif |
| `--accent-border` | `rgba(110,123,255,0.42)` | contour d'un état actif ou focus |
| `--on-accent` | `#0b0c0e` | texte posé sur un fond `--accent` |
| `--danger` | `#f2555a` | sévérité rouge, erreur, suppression |
| `--danger-soft` | `rgba(242,85,90,0.12)` | fond d'alerte rouge, ligne de diff supprimée |
| `--warn` | `#f0a852` | sévérité orange, avertissement |
| `--warn-soft` | `rgba(240,168,82,0.12)` | fond d'alerte orange |
| `--ok` | `#4ec9a5` | succès, ajout, tour terminé |
| `--ok-soft` | `rgba(78,201,165,0.12)` | fond de succès, ligne de diff ajoutée |
| `--neutral-soft` | `rgba(255,255,255,0.05)` | sévérité grise, information neutre |

### Rayons, espacement, ombres

| Token | Valeur |
| --- | --- |
| `--r-xs` / `--r-sm` / `--r-md` / `--r-lg` / `--r-full` | `3px` / `5px` / `8px` / `12px` / `999px` |
| `--space-1` … `--space-8` | `4px 8px 12px 16px 20px 24px 32px 40px` |
| `--shadow-overlay` | `0 18px 48px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4)` |
| `--shadow-popover` | `0 8px 24px rgba(0,0,0,0.45)` |

### Typographie

| Token | Valeur |
| --- | --- |
| `--font-sans` | `ui-sans-serif, -apple-system, "Inter", "Segoe UI", Roboto, sans-serif` |
| `--font-mono` | `ui-monospace, "JetBrains Mono", "SFMono-Regular", Consolas, monospace` |
| `--text-xs` | `11px` / line-height 1.45 / `letter-spacing .06em` en majuscules |
| `--text-sm` | `12px` / 1.5 — métadonnées, chips |
| `--text-base` | `13px` / 1.55 — interface courante |
| `--text-md` | `15px` / 1.6 — corps de message dans le fil |
| `--text-lg` | `17px` / 1.35 — titre de vue |
| `--text-code` | `12.5px` / 1.6 — diff, sorties, SHA |

Poids : 400 pour le corps, 500 pour les libellés, 600 pour les titres. Jamais de
700 : la graisse porte peu de sens à cette densité.

Les libellés de section (« PROJETS », « CONVERSATIONS ») sont en `--text-xs`,
majuscules, `--text-faint`, `letter-spacing .07em`.

### Mouvement

| Token | Valeur |
| --- | --- |
| `--ease` | `cubic-bezier(0.2, 0, 0, 1)` |
| `--dur-fast` | `120ms` — survol, focus |
| `--dur` | `180ms` — ouverture de panneau, dépliage |

Tout ce qui bouge doit être neutralisé sous `@media (prefers-reduced-motion: reduce)`.

## Règles d'application

- **Focus visible obligatoire** : `:focus-visible` → `outline: 2px solid var(--accent); outline-offset: 1px`. Ne jamais supprimer l'outline sans le remplacer.
- **Cibles cliquables** : 28 px de haut minimum dans la sidebar, 32 px ailleurs.
- **Une carte** = `--bg-raised` + `1px solid var(--border-subtle)` + `--r-md`. Pas d'ombre.
- **Un champ** = `--bg-input` + `1px solid var(--border)` + `--r-sm` ; au focus, bordure `--accent-border` + ring accent.
- **Un bouton primaire** = fond `--accent`, texte `#0b0c0e`. **Secondaire** = fond transparent, bordure `--border`, texte `--text`. **Discret** = pas de bordure, survol `--bg-hover`.
- **Diff** : ajout = fond `--ok-soft` + liseré gauche 2px `--ok` ; suppression = `--danger-soft` + liseré `--danger`. Les numéros de ligne sont en `--text-faint`, mono, `tabular-nums`, non sélectionnables.
- **Sévérités Gardien** : rouge `--danger`, orange `--warn`, gris `--neutral-soft`. Toujours accompagnées d'un libellé texte, jamais de la couleur seule.
- **Scrollbars** : `scrollbar-width: thin`, pouce `--border-strong`, piste transparente.
- Aucun `px` de couleur ou de taille en dur dans un composant : si un token manque, l'ajouter ici d'abord.

## Chrome de fenêtre

La fenêtre est **sans décoration native** (`decorations: false`). La barre de
titre est un composant React de 36 px :

- Zone de glissement via `data-tauri-drag-region`.
- À gauche : nom de l'app puis fil d'Ariane discret (projet · vue).
- À droite : réduire, agrandir/restaurer, fermer — 32 × 32, icônes 10-12 px
  dessinées en SVG inline, survol `--bg-hover`, survol de « fermer » `--danger`.
- Rendue **uniquement sous Tauri** (`'__TAURI_INTERNALS__' in window`) : en dev
  navigateur, l'interface doit rester identique sans barre.
- Poignées de redimensionnement invisibles sur les quatre bords et les quatre
  coins, câblées sur `startResizeDragging` — sans décoration native, le
  gestionnaire de fenêtres ne les fournit plus.
- Permissions à ajouter dans `src-tauri/capabilities/default.json` :
  `core:window:allow-minimize`, `allow-maximize`, `allow-unmaximize`,
  `allow-toggle-maximize`, `allow-is-maximized`, `allow-close`,
  `allow-start-dragging`, `allow-start-resize-dragging`.

## Organisation des feuilles de style

`ui/src/App.css` est découpé en modules importés depuis `ui/src/styles/index.css` :

```
styles/tokens.css      tokens + base (reset, scrollbars, focus, typographie)
styles/shell.css       app-shell, titlebar, en-têtes de vue, onglets
styles/sidebar.css     projets, conversations, quotas, jauge de contexte
styles/chat.css        fil, blocs d'événements, cartes outil, lightbox
styles/composer.css    zone de saisie, actions, sélecteurs de modèle
styles/guardian.css    vue Gardien, flags, décisions, contre-avis
styles/diff.css        DiffViewer, numéros de ligne, zones thermiques
styles/git.css         graphe Git, branches, commits, worktrees
styles/cards.css       sous-tâches, débrief, inventaire de test
styles/dialogs.css     modales, formulaires, confirmations
```

Le découpage est un simple déplacement de règles : aucune règle ne disparaît
sans être réécrite dans son module.
