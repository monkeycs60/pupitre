# Task 5 - Fix round 1

## Résumé

Corrections apportées au client ClickUp du sidecar :

- suppression du plafond fixe sur `assignedTasks()` pour continuer jusqu'à `last_page`,
- troncature explicite de `taskContext().description` à 2000 caractères,
- garde-fous explicites sur les erreurs HTTP avec `403 -> ClickUpAuthError` et les autres statuts non-auth -> `ClickUpHttpError`.

## Fichiers modifiés

- `sidecar/src/integrations/clickup.ts`
- `sidecar/tests/clickup.test.ts`

## Détails techniques

- `assignedTasks()` boucle désormais sans plafond numérique arbitraire et avance page par page tant que l’API renvoie `last_page === false`.
- `taskContext()` borne la description à 2000 caractères avant de renvoyer le contexte.
- Les tests couvrent maintenant :
  - la pagination au-delà de 100 pages,
  - la troncature de description à 2000 caractères,
  - `401`, `403` et un statut HTTP non-auth distinct.

## Commandes exécutées et résultats

### Cycle TDD ciblé

Commande :

```bash
cd sidecar && bun test tests/clickup.test.ts
```

Premier passage :

- `assignedTasks continue au-delà de 100 pages jusqu'à last_page` en échec, avec `Expected length: 101 / Received length: 100`.
- `taskContext tronque la description à 2000 caractères` en échec, avec `Expected length: 2000 / Received length: 2500`.
- `403 devient une ClickUpAuthError` et `un HTTP non-auth devient une ClickUpHttpError` passaient déjà.

Après correction :

- 8 tests passés
- 0 test échoué
- 21 expect() calls

### Vérification complète

Commande :

```bash
cd sidecar && bun test
```

Résultat :

- 557 tests passés
- 0 test échoué
- 1666 expect() calls

## Point d’attention

Le changement de code est limité au sidecar. Aucun appel réseau réel n’a été ajouté aux tests.
