# Jarvis

Jarvis répond aux questions sur tes agents, dans tous les projets : où est
l'agent qui travaille sur un sujet, qui t'attend, ce qui tourne sur un port.
La pastille **Demander à Jarvis** en bas à droite l'ouvre, comme **Ctrl J**.

## Ce que montre une réponse

- **Qui a répondu et pourquoi.** En mode **Auto**, Jev, le modèle de décision
  de TypeSafe, lit ta demande dès son envoi.
  - Une recherche de conversation (« où on a parlé de… », ou quelques mots
    tapés comme dans une barre de recherche) lui suffit : il compare tes
    conversations et désigne la bonne, sans Claude, en 0,3 seconde environ.
    S'il hésite, Haiku 5.5 relit. **Demander à Haiku 5.5**, sous la liste, donne
    une réponse rédigée à la demande.
  - Une demande qui appelle un plan de plusieurs actions part directement chez
    Opus 5.5 (effort high).
  - Le reste va à Haiku 5.5 (effort high), qui passe encore la main à Opus dès
    qu'il voit un plan dans les données.

  **Rapide** force Haiku, **Orchestrer** force Opus. Jev demande une clé
  TypeSafe dans **Réglages › Tokens d'intégration** ; sans elle, Haiku répond
  d'abord.
- **Ce qu'il a fait**, étape par étape : état des agents, recherche dans les
  conversations, serveurs, choix du modèle. La trace se replie une fois la
  réponse prête.
- **Les conversations trouvées**, avec les passages qui répondent. Un clic
  ouvre la conversation et surligne ces passages, en dépliant le travail du tour
  s'ils s'y trouvent ; la barre en haut du fil passe de l'un à l'autre.
- **Les actions proposées** : répondre à un agent, démarrer une conversation,
  archiver, épingler, interrompre un tour, ouvrir un serveur.

## Les raccourcis

**Qui m'attend ?** et **Qu'est-ce qui tourne ?**, au-dessus du champ, répondent
aussitôt depuis l'état de Pupitre, sans aucun modèle et quel que soit le mode :
les conversations qui t'attendent avec leur question et les réponses que
l'agent propose, les agents en cours et les serveurs qui écoutent.

En mode **Auto**, taper ces questions à ta façon (« y a des agents qui
m'attendent ? ») donne la même réponse : Jev les reconnaît. **Demander à Haiku
5.5**, sous la réponse, reste possible si ce n'était pas ta question.

## Tu gardes la main

Jarvis ne modifie rien seul. Une action qui change quelque chose demande deux
clics, **Exécuter** puis **Confirmer**, et dit avant ce qui va se passer. Le
message envoyé à un agent ou le premier message d'une nouvelle conversation
reste modifiable jusque-là. **Tout exécuter** demande aussi une confirmation.

Une recherche prend 0,3 seconde, un raccourci moins encore. Une question que
Haiku rédige prend une dizaine de secondes. Un plan en prend une quarantaine,
presque toute pour Opus : Jev tranche avant même que Haiku démarre.
Ouvrir le panneau lance les modèles d'avance, ce qui retire leur démarrage de
l'attente. Pendant que le panneau est ouvert, les notifications se masquent ;
elles reviennent à sa fermeture. **Arrêter** interrompt la recherche en cours.

## Suivre l'usage de Jarvis

**Rapport › Usage** compte les questions de la période selon qui a répondu
(Jev seul, état de Pupitre, Haiku seul, Jev puis Opus, Haiku puis Opus, ou un
mode imposé), avec la durée médiane et les échecs. Un second tableau suit chaque
type d'action proposée : combien de fois Jarvis l'a proposée, exécutée, ignorée
ou vue échouer. Ce suivi reste sur la machine.

## Ce qui sort de la machine

- **TypeSafe (Jev), en mode Auto :** ta demande et les deux derniers échanges.
  Pour une recherche, aussi le titre, le projet et le résumé de tes 254
  conversations les plus récentes, et les passages qui contiennent tes mots.
- **Anthropic (Haiku, Opus) :** la demande et les données préparées pour le
  modèle, quand il est appelé.
- **Les raccourcis :** rien.
- **La recherche sémantique, si elle est active :** les conversations chez
  OpenAI pour l'indexation, les extraits candidats chez Cerebras pour le tri.
