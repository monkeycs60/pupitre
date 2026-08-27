# Résumé de session et handoff

Le menu **Actions** propose **Résumé session** pour obtenir un bilan court des
changements concrets : fonctionnalités ou correctifs implémentés, puis éléments
restant explicitement à terminer lorsqu'il y en a. Le résumé est généré depuis
le dernier point de session et ajouté au fil sans remplacer la conversation.
Il ne génère ni validation ni entrée de changelog : le catalogue du projet se
met à jour séparément depuis son historique Git.

Le bouton **Handoff**, à côté de la jauge de contexte, sert à transférer le
travail vers une nouvelle conversation. Il génère le débrief complet de
passation, l'affiche en Markdown et permet de créer une conversation cible, de
copier le document ou de l'enregistrer.

Lors d'un changement de provider, Pupitre conserve ce même handoff complet et
initialise la nouvelle conversation avec son contenu au lieu de repartir d'un
résumé séparé.
