# Mémoire Claude

L'explorateur **Mémoire** lit les fichiers présents dans `~/.claude/memory`.
Ils restent locaux : aucun modèle n'est appelé pour les afficher ou les éditer.

L'éditeur écrit le fichier de façon atomique et refuse les chemins extérieurs,
les symlinks et les fichiers trop volumineux. Une suppression exige une
confirmation. Pupitre avertit aussi avant d'abandonner un brouillon non
enregistré.
