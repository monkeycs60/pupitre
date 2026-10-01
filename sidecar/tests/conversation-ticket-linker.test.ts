import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db';
import { ProjectStore } from '../src/stores/projects';
import { ConversationStore } from '../src/stores/conversations';
import { TicketStore } from '../src/stores/tickets';
import { ConversationTicketLinker } from '../src/conversation-ticket-linker';

function setup() {
  const db = openDb(mkdtempSync(join(tmpdir(), 'pupitre-ticket-linker-')));
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const tickets = new TicketStore(db);
  const project = projects.create({ name: 'Mono', path: '/tmp' });
  const ticket = tickets.upsert(project.id, { key: 'TECH-12', title: 'Uniformisation Sheets', source: 'clickup', status: 'open', externalUrl: 'https://app.clickup.com/t/abc12' });
  const conversation = conversations.create({ projectId: project.id, provider: 'codex', model: 'test', firstMessage: 'Inventaire outils IA' });
  return { db, projects, conversations, tickets, project, ticket, conversation };
}

test('rattache une référence tardive et une branche connue sans modèle', async () => {
  const c = setup();
  c.conversations.appendEvent(c.conversation.id, { type: 'user-message', text: 'Travaille sur TECH-12', images: [] });
  let calls = 0;
  const linker = new ConversationTicketLinker(c.db, c.projects, c.conversations, c.tickets, async () => { calls++; return null; });
  expect(await linker.scan()).toBe(1);
  expect(c.conversations.get(c.conversation.id)?.ticket_id).toBe(c.ticket.id);
  const other = c.conversations.create({ projectId: c.project.id, provider: 'codex', model: 'test', firstMessage: 'Correction', worktreePath: '/tmp/feature-TECH-12' });
  c.tickets.upsertRef(c.ticket.id, { kind: 'branch', ref: 'feature/TECH-12', payload: {} });
  expect(await linker.scan()).toBe(1);
  expect(c.conversations.get(other.id)?.ticket_id).toBe(c.ticket.id);
  expect(calls).toBe(0);
  c.db.close();
});

test('la relecture accepte un titre cité avec preuve et conserve les cas ambigus', async () => {
  const c = setup();
  c.conversations.appendEvent(c.conversation.id, { type: 'user-message', text: 'Prépare le ticket Uniformisation Sheets', images: [] });
  const linker = new ConversationTicketLinker(c.db, c.projects, c.conversations, c.tickets, async () => ({ ticketId: c.ticket.id, evidence: 'le ticket Uniformisation Sheets' }));
  expect(await linker.scan()).toBe(1);
  const second = c.tickets.upsert(c.project.id, { key: 'TECH-13', title: 'Autre', source: 'git', status: '', externalUrl: null });
  const ambiguous = c.conversations.create({ projectId: c.project.id, provider: 'codex', model: 'test', firstMessage: 'Comparer' });
  c.conversations.appendEvent(ambiguous.id, { type: 'user-message', text: 'Comparer TECH-12 et TECH-13', images: [] });
  expect(await linker.scan()).toBe(0);
  expect(c.conversations.get(ambiguous.id)?.ticket_id).toBeNull();
  c.tickets.linkConversation(ambiguous.id, second.id);
  expect(await linker.scan()).toBe(0);
  expect(c.conversations.get(ambiguous.id)?.ticket_id).toBe(second.id);
  c.db.close();
});

test('refuse une preuve inventée et évite de relire les conversations inchangées', async () => {
  const c = setup();
  c.conversations.appendEvent(c.conversation.id, { type: 'user-message', text: 'Uniformisation et Sheets sont des sujets généraux', images: [] });
  const invalid = new ConversationTicketLinker(c.db, c.projects, c.conversations, c.tickets, async () => ({ ticketId: c.ticket.id, evidence: 'le ticket Uniformisation Sheets' }));
  expect(await invalid.scan()).toBe(0);
  let calls = 0;
  const noMatch = new ConversationTicketLinker(c.db, c.projects, c.conversations, c.tickets, async () => { calls++; return { ticketId: null, evidence: '' }; });
  await noMatch.scan();
  await noMatch.scan();
  expect(calls).toBe(1);
  c.db.close();
});

test('le retrait conserve l’historique et le réajout restaure l’ordre choisi', () => {
  const c = setup();
  const other = c.projects.create({ name: 'Autre', path: '/tmp/other' });
  c.projects.reorder([c.project.id, other.id]);
  expect(c.projects.list().map((item) => item.id)).toEqual([c.project.id, other.id]);
  expect(() => c.projects.reorder([other.id, other.id])).toThrow();
  c.projects.remove(c.project.id);
  expect(c.projects.list().map((item) => item.id)).toEqual([other.id]);
  expect(c.conversations.get(c.conversation.id)).not.toBeNull();
  expect(c.projects.create({ name: 'Restauré', path: '/tmp' }).id).toBe(c.project.id);
  expect(c.projects.list().map((item) => item.id)).toEqual([c.project.id, other.id]);
  c.db.close();
});

test('importe le ticket principal manquant sans confondre les références secondaires', async () => {
  const c = setup();
  c.conversations.appendEvent(c.conversation.id, { type: 'user-message', text: 'https://app.clickup.com/t/20556900/TECH-25220 par rapport à ce ticket', images: [] });
  c.conversations.appendEvent(c.conversation.id, { type: 'user-message', text: 'Voir aussi TECH-12', images: [] });
  const refs: string[] = [];
  const linker = new ConversationTicketLinker(c.db, c.projects, c.conversations, c.tickets, async () => null, async (projectId, ref) => {
    refs.push(ref);
    return c.tickets.upsert(projectId, { key: ref, title: 'Outils IA', source: 'clickup', status: 'open', externalUrl: null });
  });
  expect(await linker.scan()).toBe(1);
  expect(refs).toEqual(['TECH-25220']);
  expect(c.tickets.get(c.conversations.get(c.conversation.id)!.ticket_id!)?.key).toBe('TECH-25220');
  c.db.close();
});
