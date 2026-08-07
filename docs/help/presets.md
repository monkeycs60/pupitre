# Presets

Un preset mémorise provider, modèle, effort, vitesse, orchestration et, si vous
le souhaitez, le preset/effort imposé aux sub-agents. Il évite de reconfigurer
chaque nouvelle conversation et peut devenir le défaut d'un projet.

La carte Configuration expose aussi l'**autonomie** du preset (dont le mode
YOLO), mais la portée filesystem n'est pas un réglage de conversation. Elle
se hiérarchise ainsi :

- **Application** : `Outils → Application → Paramètres` définit le défaut des
  nouveaux projets.
- **Projet** : le bouton `⚙` à droite d'un projet définit sa portée pour toutes
  ses conversations.
- **Conversation** : affiche la portée héritée du projet, sans la modifier.

Par défaut, chaque projet peut écrire dans son dossier et dans les racines IA
`~/.claude` et `~/.codex` afin de gérer `CLAUDE.md`, `AGENTS.md`, les skills,
prompts et la mémoire. `Tout le système` élargit explicitement cette portée
après confirmation.

Dans la zone Sub-agents, « Choix du modèle principal » conserve le routage
dynamique. Un preset imposé verrouille le provider, le modèle et la vitesse des
sous-tâches ; son effort est repris par défaut, avec possibilité de le forcer.

**Tous les presets sont modifiables**, y compris les trois livrés avec Pupitre
— **Éco**, **Qualité max** et **Vitesse**. Le menu `⋯` de la carte de
configuration permet de les renommer, de les écraser avec les réglages
courants, d'en définir un par défaut pour le projet, ou d'en créer un nouveau.
Les trois intégrés ne peuvent pas être supprimés, mais eux seuls savent revenir
à leurs valeurs d'origine (« Restaurer les valeurs d'origine »). Changer de modèle
dans un fil existant conserve la session seulement au sein du même provider ;
un changement de provider crée une passation via Débrief.
