# Gardien

Gardien relit un diff Git avec un modèle fort et ancre chaque constat sur les
lignes concernées. Il surligne, vous dirigez : rien n'est bloqué, rien n'est à
acquitter pour continuer.

« Relire » lance une review depuis l'onglet **Code › Changements**. Le diff
est découpé en **zones** scannées en lecture seule ; la progression s'affiche
en `Zone N/M` sur le bouton.

Chaque **signalement** apparaît inline dans le diff, avec sa raison et trois
actions : **Corriger** envoie un agent traiter le point, **OK, vu** clôt le
signalement lu, **Ignorer** l'écarte comme faux positif. Une fois toutes les
corrections en cours terminées, Gardien relit automatiquement le worktree —
en incrémental : seuls les hunks changés sont rescannés, les autres recopient
leurs signalements.

Le modèle utilisé se règle dans **Réglages du projet** : un preset pour la
review, un autre pour la correction.

Chaque signalement porte une sévérité au sens red flag — Rouge : ce qui ne
devrait jamais apparaître dans le code ; Orange : moins grave mais aux
implications potentiellement sérieuses ; Gris : correct mais améliorable. La
nature du constat est portée par sa catégorie, jamais par sa couleur.
