# Progression

Pupitre transforme l'activité réelle en progression personnelle. L'XP vient des tokens consommés, des commits liés à une conversation et des commits retrouvés sur une branche distante, donc considérés comme poussés.

## Complexité

Chaque conversation reçoit une estimation de complexité de C0 à C6. C'est un multiplicateur d'XP, pas une note de qualité :

| Niveau | Multiplicateur |
| --- | ---: |
| C0 | ×1,00 |
| C1 | ×1,05 |
| C2 | ×1,10 |
| C3 | ×1,20 |
| C4 | ×1,30 |
| C5 | ×1,45 |
| C6 | ×1,60 |

## Focus actif

Le temps actif correspond au temps passé sur une fenêtre Pupitre visible et au premier plan, avec une interaction récente au clavier ou à la souris. Une période sans interaction de cinq minutes arrête le compteur.

Le bonus augmente de `+0,03` toutes les dix minutes actives, à partir de minuit et jusqu'à `23 h 50` de temps actif cumulé. Le multiplicateur maximal de la journée est donc `×5,29`.

## Rapport hebdomadaire

La vue Progression rassemble les projets impactés, conversations, commits et pushes, lignes ajoutées et supprimées, tokens input/output, temps actif, XP et répartition C0–C6. Le rapport peut être copié pour être comparé avec des collègues ou des amis.
