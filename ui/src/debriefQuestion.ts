import type { DebriefBlock } from './groupEvents'

export function debriefQuestionPrompt(block: DebriefBlock): string {
  return [
    `Question sur le débrief couvrant les événements ${block.eventIdFrom} à ${block.eventIdTo}.`,
    "Explique-moi la réponse comme à un collègue et cite les événements [événement #N] qui l'étayent.",
    '',
    'Ma question :',
    '',
    'Débrief de référence :',
    block.contentMd,
  ].join('\n')
}
