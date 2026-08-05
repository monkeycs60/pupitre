# Gardien

Gardien relit un diff Git avec un modèle fort et ancre chaque risque sur les
lignes concernées. Il ne remplace pas votre décision : chaque point rouge,
orange ou gris doit être acquitté ou écarté séparément.

Le mode **informatif** laisse les actions continuer. Le mode **bloquant** refuse
les opérations protégées tant qu'un risque rouge reste ouvert. Il n'existe pas
de validation globale, afin qu'une décision importante ne disparaisse pas dans
un clic général.

Un **contre-avis** demande au provider opposé de contester un point. Il peut le
confirmer, le nuancer ou le rejeter ; le verdict reste attaché au signalement.
