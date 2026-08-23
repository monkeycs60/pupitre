# Domaines et labels — tranche B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or implement task-by-task with TDD.

**Goal:** Ajouter une taxonomie de **domaines** par projet, relier les conversations à ces domaines, et n'afficher un label que s'il a été validé.

**Architecture:** SQLite (`domains`, `conversation_domains`) + `DomainStore`. Le digest haiku existant propose 1–2 domaines dans le même JSON, sans tour LLM supplémentaire. Un nom inconnu naît en `proposé` ; les pastilles, le filtre de recherche et le payload public des conversations ne voient que le statut `actif`. ClickUp (champ Service) et les skills projet amorcent des propositions, jamais des labels visibles.

**Tech Stack:** Bun, SQLite, React 19, Vite, Testing Library.

**Spec:** `docs/plans/2026-08-19-tableau-de-bord-design.md` §5 Labels de domaine. Hors périmètre : changelog (C), Notion/Répétitions (D).

## Décisions

| Sujet | Choix |
| --- | --- |
| Visibilité | `conversation_domains` conserve la suggestion `auto` même si le domaine est `proposé`. Les surfaces publiques (`Conversation.domains`, pastilles, filtre recherche) ne listent que `status = 'actif'`. |
| Digest | JSON `{ title, summary, domains: [{ name, kind }] }`, 0 à 2 items. Kind invalide → `technique`. Catalogue existant injecté dans le prompt. |
| Création manuelle | Un domaine créé depuis les réglages naît `actif`. Digest / ClickUp / skills naissent `proposé`. |
| Unicité | `UNIQUE(project_id, name)` avec `name COLLATE NOCASE`. Normalisation : trim + espaces collapsés, max 48. |
| Fusion | Réassigne les associations vers la cible (`INSERT OR IGNORE`), conserve `origin`/`created_at` d'origine, supprime la source. |
| Suppression | 409 si des associations existent. Il faut dissocier ou fusionner d'abord. |
| Recherche | `GET /api/search?q=&projectId=&domainId=` borne aux conversations liées à un domaine **actif**. |
| WS | Le digest existant rafraîchit déjà la sidebar (`conversationListVersion`). Les actions de réglages forcent le même rechargement. |

## File map

| Fichier | Rôle |
| --- | --- |
| `sidecar/src/db.ts` | Tables `domains`, `conversation_domains` |
| `sidecar/src/stores/domains.ts` | CRUD, fusion, suggestions digest, amorçage |
| `sidecar/src/conversation-digest.ts` | Parse `domains`, prompt borné |
| `sidecar/src/runner.ts` | Applique les suggestions après le digest |
| `sidecar/src/integrations/refresher.ts` | Propose les labels ClickUp Service |
| `sidecar/src/search.ts` | Filtre optionnel par conversation_id |
| `sidecar/src/server.ts` | Routes projet / conversation / search |
| `ui/src/ProjectSettingsDialog.tsx` | Liste, valider, renommer, fusionner |
| `ui/src/Sidebar.tsx` | Pastilles des domaines actifs |
| `ui/src/CommandPalette.tsx` | Filtre par domaine |

## API

```
GET    /api/projects/:id/domains
POST   /api/projects/:id/domains                 { name, kind }           → actif
POST   /api/projects/:id/domains/:id/validate
PATCH  /api/projects/:id/domains/:id             { name?, kind? }
POST   /api/projects/:id/domains/:id/merge       { targetId }
DELETE /api/projects/:id/domains/:id             409 si associations
POST   /api/conversations/:id/domains            { domainId }            → origin manuel
DELETE /api/conversations/:id/domains/:domainId
GET    /api/search?q=&projectId=&domainId=
```

`GET /api/projects/:id/conversations` enrichit chaque conversation de `domains` (actifs seulement).

`GET /api/projects/:id/domains` amorce les propositions depuis les labels ClickUp des tickets et les skills projet, sans jamais promouvoir en `actif`.

## Tâches

1. Schéma SQLite + tests d'unicité / cascade.
2. `DomainStore` : proposer, valider, renommer, fusionner, suppression protégée, associations, suggestions digest.
3. Digest : parse borné + prompt + application dans le runner.
4. Relève ClickUp : `proposeMany` des labels Service.
5. Routes API + filtre recherche + décoration des conversations.
6. UI réglages projet.
7. Pastilles sidebar + filtre palette.
8. Docs `docs/help/tableau-de-bord.md` + tests UI + vérif navigateur.

Chaque tâche : test rouge, implémentation minimale, test vert, commit français.
