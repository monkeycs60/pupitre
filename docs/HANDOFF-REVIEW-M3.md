# Handoff de review M3

État préparé le 2026-08-05 pour une contre-review externe.

## Situation exacte

- Dépôt : `/home/clement/Desktop/pupitre`
- Branche : `master`
- Dernier commit : `39d4d00 fix: ferme les dernières courses de clôture M3`
- Diff complet du jalon : `m2..39d4d00`
- Le tag `m3` n'a **pas** encore été créé.
- M3 a été exécutée dans l'ordre demandé : `T0 → G → H → J → I`.
- Aucun appel Claude réel n'a été fait pendant l'implémentation ou les smokes M3.

## Vérifications déjà réussies

Après `39d4d00` :

```text
cd sidecar && bun test             254 pass, 0 fail, 833 assertions
cd sidecar && bunx tsc --noEmit    OK
cd ui && bunx tsc --noEmit         OK
cd ui && bun run build             OK
cd src-tauri && cargo check         OK
git diff --check                    OK
```

Un smoke du vrai frontend a aussi été rejoué avec `agent-browser` et des fake
bins déterministes : création projet/conversation Codex, streaming et outils,
vue Git, review Gardien `CONVERSATION → WORKTREE`, Tester jusqu'à `RÉUSSI`, puis
Débrief. Capture : `e2e/pupitre-m3-gardien.png`.

## Historique des reviews finales

La première review globale du diff depuis `m2` a remonté cinq points Important,
corrigés dans `fa65ef2` :

1. Gardien ne couvrait que `HEAD^ → HEAD` : défaut changé en
   `CONVERSATION → WORKTREE`, y compris commits liés, staged, unstaged et
   fichiers non suivis.
2. Un crash pendant un handoff pouvait laisser une continuation incomplète :
   ajout du marqueur persistant `handoff_pending` et nettoyage au boot.
3. Tauri lançait le sidecar sans le superviser : drainage des événements,
   redémarrage après crash et arrêt avec l'application.
4. La limite du diff Gardien était contrôlée après buffering : lecture Git
   désormais interrompue dès 2 Mio.
5. La documentation E2E surpromettait certains parcours navigateur : matrice
   corrigée pour distinguer navigateur et intégration.

La contre-review ciblée de `fa65ef2` a ensuite remonté trois points Important,
corrigés dans `39d4d00` :

1. Une ancienne review `WORKTREE` était rattachée au `HEAD` courant à chaque
   lecture. Les nouvelles reviews figent maintenant le SHA observé au scan ; les
   anciens marqueurs `WORKTREE` ne sont plus affichés sur un commit arbitraire.
2. Le sweep supprimait un handoff dont le statut `done` avait été persisté juste
   avant un crash. Le boot finalise maintenant ce handoff et conserve ses events.
3. Un arrêt Tauri pouvait tomber entre le spawn et l'enregistrement du child. Le
   flag `stopping` est maintenant revérifié sous le mutex ; le child est soit
   enregistré puis récupéré par l'arrêt, soit tué immédiatement.

## Contre-review interrompue à vérifier

Une dernière contre-review Codex haute de `39d4d00` a été interrompue à la
demande de l'utilisateur car elle était trop longue. Elle n'avait encore publié
aucun constat final, mais examinait notamment cette fenêtre :

- `sidecar/src/reviews.ts` résout `HEAD`, puis lance séparément
  `worktreeDiff()`. Si `HEAD` change exactement entre les deux opérations, le SHA
  mémorisé pourrait ne pas correspondre au diff capturé. Déterminer si ce cas
  mérite un retry avec contrôle `HEAD avant == HEAD après`, ou s'il est acceptable
  au regard du niveau de sévérité demandé.

Les tentatives de tests lancées par cette review ont échoué uniquement parce que
son sandbox read-only interdisait `mkdtemp` sous `$TMPDIR`; la batterie locale
ci-dessus a bien passé hors de ce sandbox.

## Clôture de ce handoff (2026-08-05)

La troisième passe de review a été menée et **tous les points ci-dessus sont
traités**. La course entre la résolution de `HEAD` et `worktreeDiff` était bien
réelle : elle est corrigée, et la même passe a mis au jour cinq autres constats
Critical/Important dans le moteur Gardien, le stockage des conversations et la
supervision Tauri. Le détail des sept corrections et la dette reportée à M4 sont
consignés dans `docs/HANDOFF-M3-M4.md`, section « Verdict de la review finale ».
Chaque correction est couverte par un test qui échouait avant elle.

Ce document reste comme trace de la préparation de la review ; il n'y a plus rien
à reprendre depuis ici.

## Travail non commité volontairement

```text
 M README.md
 M docs/HANDOFF-M3-M4.md
 M e2e/basic-flow.md
?? docs/HANDOFF-REVIEW-M3.md
?? e2e/pupitre-m3-gardien.png
```

Ces fichiers documentaient la livraison et le smoke. Ils ont depuis été mis à
jour (`263 tests` après les corrections de la review finale) et committés avec
le verdict.

## Ce qui restait après validation (fait)

1. ✅ Constats Critical/Important corrigés, chacun avec son test de régression.
2. ✅ Batterie complète rejouée avant les commits :

   ```bash
   cd sidecar && bun test && bunx tsc --noEmit
   cd ui && bunx tsc --noEmit && bun run build
   cd src-tauri && cargo check
   ```

3. ✅ Comptes de tests portés à `263`, verdict consigné dans
   `docs/HANDOFF-M3-M4.md`, docs et capture committées.
4. ✅ Tag annoté `m3` créé, comme `m2`.
5. ✅ Rien n'a été poussé.

## Prompt de review conseillé

```text
Ouvre /home/clement/Desktop/pupitre et lis docs/HANDOFF-REVIEW-M3.md,
docs/HANDOFF-M3-M4.md et docs/HANDOFF-M2.md. Fais une review finale du diff
m2..39d4d00 en te concentrant uniquement sur les bugs Critical/Important.
Commence par vérifier les trois corrections de 39d4d00 et la possible course
entre la résolution de HEAD et worktreeDiff dans sidecar/src/reviews.ts. Ignore
les fichiers de documentation non commités pendant la review du code. Ne modifie
rien : rends une liste concise fichier:ligne + impact, ou exactement
« Aucun constat Critical/Important. » si le jalon est propre.
```
