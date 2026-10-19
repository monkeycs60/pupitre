import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db';
import { ProjectStore } from '../src/stores/projects';
import { ConversationStore } from '../src/stores/conversations';
import { ConversationNudgeService, nudgePrompt, parseNudgeVerdicts, type NudgeCandidate, type NudgeVerdict } from '../src/conversation-nudges';

const START = Date.parse('2026-10-19T10:00:00.000Z');
const minutes = (count: number) => new Date(START + count * 60_000).toISOString();

function setup(judge: (candidates: NudgeCandidate[]) => NudgeVerdict[] = () => []) {
  const db = openDb(mkdtempSync(join(tmpdir(), 'pupitre-nudges-')));
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const project = projects.create({ name: 'Pupitre', path: '/tmp' });
  let now = START;
  const running = new Set<string>();
  const calls: NudgeCandidate[][] = [];
  const service = new ConversationNudgeService(
    db,
    async (candidates) => { calls.push(candidates); return judge(candidates); },
    () => 10,
    (id) => running.has(id),
    () => ['TODO', 'FOLLOW-UP'],
    () => now,
  );
  function answered(text: string, at = 0, state: 'done' | 'error' = 'done') {
    const conversation = conversations.create({ projectId: project.id, provider: 'claude', model: 'test', firstMessage: 'Chantier' });
    conversations.appendEvent(conversation.id, { type: 'user-message', text: 'Vas-y', images: [] }, minutes(at));
    conversations.appendEvent(conversation.id, { type: 'text-final', text }, minutes(at));
    conversations.appendEvent(conversation.id, { type: 'status', state }, minutes(at));
    conversations.markAnswered(conversation.id);
    return conversation;
  }
  return { db, conversations, service, running, calls, answered, advance: (count: number) => { now += count * 60_000; } };
}

const choice = 'Fini.\n\n*TODO*\n1. Qui réalise le commit : l\'agent committe OU Clément committe';

test('ne réveille pas Haiku tant que rien ne demande une décision', async () => {
  const c = setup();
  c.answered('Tout est fait, rien à signaler.');
  c.advance(10);
  expect(await c.service.scan()).toBe(0);
  expect(c.calls).toHaveLength(0);
  c.db.close();
});

test('propose un choix une seule fois et le retire dès que Clément répond', async () => {
  const c = setup((candidates) => candidates.map((candidate) => ({
    conversationId: candidate.conversationId,
    kind: 'choice',
    title: 'Qui committe ?',
    body: 'Le chantier est prêt.',
    actions: [
      { label: "L'agent committe", message: "Réponse à « Qui réalise le commit » : l'agent committe" },
      { label: 'Clément committe', message: 'Réponse à « Qui réalise le commit » : Clément committe' },
    ],
  })));
  const conversation = c.answered(choice);
  c.advance(1);
  expect(await c.service.scan()).toBe(0);
  c.advance(5);
  expect(await c.service.scan()).toBe(1);
  expect(c.calls[0]![0]!.lastAnswer).toContain('OU Clément committe');
  expect(c.service.list().map((nudge) => nudge.actions.length)).toEqual([2]);
  expect(await c.service.scan()).toBe(0);
  expect(c.calls).toHaveLength(1);

  c.conversations.appendEvent(conversation.id, { type: 'user-message', text: 'Committe', images: [] }, minutes(7));
  expect(c.service.list()).toHaveLength(0);
  c.db.close();
});

test('rappelle une réponse restée non lue une heure, même sans question', async () => {
  const c = setup((candidates) => candidates.map((candidate) => ({
    conversationId: candidate.conversationId, kind: 'review', title: 'Audit terminé', body: '', actions: [],
  })));
  const conversation = c.answered('Audit terminé : trois constats.');
  c.advance(30);
  await c.service.scan();
  expect(c.calls).toHaveLength(0);
  c.advance(40);
  expect(await c.service.scan()).toBe(1);
  expect(c.calls[0]![0]!.stage).toBe('stale');
  c.conversations.markRead(conversation.id);
  expect(c.service.list()).toHaveLength(0);
  c.db.close();
});

test('ignore une conversation en cours et garde le verdict « rien » pour ne pas redemander', async () => {
  const c = setup(() => []);
  const busy = c.answered(choice);
  c.answered(choice, 0, 'error');
  c.running.add(busy.id);
  c.advance(5);
  expect(await c.service.scan()).toBe(0);
  expect(c.calls[0]!.map((candidate) => candidate.failed)).toEqual([true]);
  await c.service.scan();
  expect(c.calls).toHaveLength(1);
  c.db.close();
});

test('écarte les actions vides et les types inconnus', async () => {
  const c = setup((candidates) => [{
    conversationId: candidates[0]!.conversationId,
    kind: 'validate',
    title: 'Committer ?',
    body: '',
    actions: [{ label: 'Oui', message: 'Oui, committe.' }, { label: '', message: 'x' }],
  }]);
  c.answered(choice);
  c.advance(5);
  await c.service.scan();
  const [nudge] = c.service.list();
  expect(nudge!.actions).toEqual([{ label: 'Oui', message: 'Oui, committe.' }]);
  expect(c.service.close(nudge!.id)).toBe(true);
  expect(c.service.list().map((item) => item.parked)).toEqual(['dismissed']);
  expect(parseNudgeVerdicts({ nudges: [{ kind: 'choice' }, { conversationId: 'a', kind: 'none' }] })).toHaveLength(1);
  expect(nudgePrompt([])).toContain('"nudges"');
  c.db.close();
});

test('une carte rappelée plus tard revient seule, une carte ignorée revient à la demande', async () => {
  const c = setup((candidates) => candidates.map((candidate) => ({
    conversationId: candidate.conversationId, kind: 'choice', title: 'Qui committe ?', body: '',
    actions: [{ label: 'Moi', message: 'Je committe.' }],
  })));
  c.answered(choice);
  c.advance(5);
  await c.service.scan();
  const [nudge] = c.service.list();
  expect(c.service.snooze(nudge!.id, 30)).toBe(true);
  expect(c.service.list()[0]!.parked).toBe('snoozed');
  c.advance(31);
  expect(c.service.list()[0]!.parked).toBeNull();

  c.service.close(nudge!.id);
  c.advance(60);
  await c.service.scan();
  expect(c.calls).toHaveLength(1);
  expect(c.service.list()).toHaveLength(1);
  expect(c.service.restore(nudge!.id)).toBe(true);
  expect(c.service.list()[0]!.parked).toBeNull();
  c.db.close();
});

test('soumet à Haiku un bloqueur écrit en toutes lettres, sans bloc TODO', async () => {
  const c = setup();
  c.answered("J'ai préparé la migration. J'attends ton accès à la base de préprod pour la lancer.");
  c.answered('La migration est passée, les tests sont verts.');
  c.answered('Le schéma est prêt. Tu préfères garder la colonne legacy ?');
  c.answered("La migration est prête, mais je dois attendre l'accès à la base de préprod.");
  c.advance(5);
  await c.service.scan();
  expect(c.calls[0]!.map((candidate) => candidate.lastAnswer.slice(0, 16)).sort()).toEqual(["J'ai préparé la ", 'La migration est', 'Le schéma est pr']);
  c.db.close();
});

test('ignore une réponse déjà lue et range la carte dès la lecture', async () => {
  const c = setup((candidates) => candidates.map((candidate) => ({
    conversationId: candidate.conversationId, kind: 'choice', title: 'Qui committe ?', body: '', actions: [],
  })));
  const read = c.answered(choice);
  c.conversations.markRead(read.id);
  const unread = c.answered(choice);
  c.advance(10);
  expect(await c.service.scan()).toBe(1);
  expect(c.calls[0]!.map((candidate) => candidate.conversationId)).toEqual([unread.id]);

  c.conversations.markRead(unread.id);
  expect(c.service.list()).toHaveLength(0);
  c.db.close();
});

test('un bloc TODO sans choix « A OU B » ne réveille pas Haiku', async () => {
  const c = setup();
  c.answered('Fini.\n\n*TODO*\n1. Confirmer le rendu dans le navigateur\n2. Attendre la CI avant de pousser\n\n*FOLLOW-UP*\n- Peux-tu relire le style ?');
  const blocked = c.answered("Il me manque le jeton d'accès Sentry pour continuer.\n\n*TODO*\n1. Fournir le jeton Sentry");
  c.advance(10);
  await c.service.scan();
  expect(c.calls.flat().map((candidate) => candidate.conversationId)).toEqual([blocked.id]);
  c.db.close();
});
