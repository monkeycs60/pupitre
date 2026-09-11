# Presets

Un preset mémorise provider, modèle, effort, vitesse et autonomie. Il évite de
reconfigurer chaque nouvelle conversation et peut devenir le défaut d'un projet.

L'**autonomie** se règle par conversation ou par projet (voir
[Autonomie](#help/autonomie)). La portée filesystem, elle, n'est pas un réglage
de conversation ; elle se hiérarchise ainsi :

- **Application** : `Outils → Application → Paramètres` définit le défaut des
  nouveaux projets.
- **Projet** : le bouton `⚙` à droite d'un projet définit sa portée pour toutes
  ses conversations.
- **Conversation** : affiche la portée héritée du projet, sans la modifier.

Par défaut, chaque projet peut écrire dans son dossier et dans les racines IA
`~/.claude` et `~/.codex` afin de gérer `CLAUDE.md`, `AGENTS.md`, les skills,
prompts et la mémoire. `Tout le système` élargit explicitement cette portée
après confirmation.

**Tous les presets sont modifiables**, y compris les trois livrés avec Pupitre
— **Éco**, **Qualité max** et **Vitesse**. Le menu `⋯` de la carte de
configuration permet de les renommer, de les écraser avec les réglages
courants, d'en définir un par défaut pour le projet, ou d'en créer un nouveau.
Les trois intégrés ne peuvent pas être supprimés, mais eux seuls savent revenir
à leurs valeurs d'origine (« Restaurer les valeurs d'origine »). Changer de modèle
dans un fil existant conserve la session seulement au sein du même provider ;
un changement de provider crée une passation via Débrief.
