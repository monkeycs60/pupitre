# Gardien

Gardien relit un diff Git avec un modèle fort et ancre chaque constat sur les
lignes concernées. Il surligne, vous dirigez : rien n'est bloqué, rien n'est à
acquitter pour continuer.

« Relire ce diff » lance une review depuis la conversation ouverte. Le diff est
découpé en **zones** scannées en lecture seule ; la progression s'affiche en
`Zone N/M` sur le bouton.

Chaque **signalement** porte une sévérité au sens red flag — Rouge : ce qui ne
devrait jamais apparaître dans le code ; Orange : moins grave mais aux
implications potentiellement sérieuses ; Gris : correct mais améliorable. La
nature du constat est portée par sa catégorie, jamais par sa couleur.

Quatre actions par signalement : **Envoyer un agent** avec une consigne
éditable, **Contre-avis** pour faire contester le point par le provider opposé,
**OK vu** et **Ignorer**. « Traiter les N ouverts » dispatche en masse. Un
signalement suit le cycle ouvert → contre-avisé → agent en cours → traité,
ignoré ou résolu.

Les reviews sont incrémentales : les hunks inchangés recopient leurs
signalements plutôt que d'être rescannés. Le rescan automatique après chaque
tour est un réglage de projet, désactivé par défaut.
