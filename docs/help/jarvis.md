# Jarvis

Jarvis répond aux questions sur tes agents, dans tous les projets : où est
l'agent qui travaille sur un sujet, qui t'attend, ce qui tourne sur un port.
La pastille **Demander à Jarvis** en bas à droite l'ouvre, comme **Ctrl J**.

## Ce que montre une réponse

- **Le modèle choisi et pourquoi.** En mode **Auto**, un routeur rapide
  (Haiku 5.5, effort low) lit ta demande dès son envoi. S'il y voit un plan de
  plusieurs actions, Opus 5.5 (effort high) le prépare directement. Sinon
  Haiku 5.5 (effort high) répond, et passe encore la main à Opus dès qu'il
  l'annonce si les données révèlent un plan. La raison s'affiche, avec qui a
  décidé. **Rapide** force Haiku, **Orchestrer** force Opus.
- **Ce qu'il a fait**, étape par étape : état des agents, recherche dans les
  conversations, serveurs, choix du modèle. La trace se replie une fois la
  réponse prête.
- **Les conversations trouvées**, avec les passages qui répondent. Un clic
  ouvre la conversation et surligne ces passages ; la barre en haut du fil
  passe de l'un à l'autre.
- **Les actions proposées** : répondre à un agent, démarrer une conversation,
  archiver, épingler, interrompre un tour, ouvrir un serveur.

## Tu gardes la main

Jarvis ne modifie rien seul. Une action qui change quelque chose demande deux
clics, **Exécuter** puis **Confirmer**, et dit avant ce qui va se passer. Le
message envoyé à un agent ou le premier message d'une nouvelle conversation
reste modifiable jusque-là. **Tout exécuter** demande aussi une confirmation.

Une question simple prend une dizaine de secondes. Un plan en prend une
quarantaine : le routeur tranche en 5 à 6 secondes et Opus démarre aussitôt.
Ouvrir le panneau lance les modèles d'avance, ce qui retire leur démarrage de
l'attente. Pendant que le panneau est ouvert, les notifications se masquent ;
elles reviennent à sa fermeture. **Arrêter** interrompt la recherche en cours.

## Suivre l'usage de Jarvis

**Rapport › Usage** compte les questions de la période selon qui a choisi le
modèle (Haiku seul, le routeur puis Opus, Haiku puis Opus, ou un mode imposé),
avec la durée médiane et les échecs. Un second tableau suit chaque type
d'action proposée : combien de fois Jarvis l'a proposée, exécutée, ignorée ou
vue échouer. Rien ne sort de la machine.
