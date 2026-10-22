#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defaultPort, readInstance } from "./instance";

function numberFromEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function conversationId(explicit?: string): string {
  const id = explicit ?? process.env.PUPITRE_CONVERSATION_ID;
  if (!id) throw new Error("conversation Pupitre inconnue");
  return id;
}

function baseUrl(): string {
  return `http://127.0.0.1:${numberFromEnv("PUPITRE_PORT", defaultPort(readInstance().name))}`;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return `${response.status} ${body.error ?? ""}`.trim();
  } catch {
    return String(response.status);
  }
}

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], ...(isError ? { isError } : {}) };
}

interface ConversationBrief {
  title: string;
  summary: string;
  debrief: string | null;
  exchanges: Array<{ role: string; text: string }>;
}

function renderConversationBrief(brief: ConversationBrief): string {
  const lines = [`# ${brief.title}`, ""];
  if (brief.summary.trim()) lines.push(brief.summary, "");
  if (brief.debrief) lines.push("## Dernier débrief", brief.debrief, "");
  lines.push("## Derniers échanges");
  for (const exchange of brief.exchanges) {
    lines.push(`**${exchange.role}** : ${exchange.text}`, "");
  }
  return lines.join("\n").trim();
}

const FULL_DISCUSSION_MAX = 120_000;

const run = promisify(execFile);

async function git(repository: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", repository, ...args], { maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    throw new Error((failure.stderr || failure.message || String(error)).trim());
  }
}

export async function commitPaths(args: {
  repository: string; paths: string[]; message: string; push?: boolean;
}): Promise<string> {
  await git(args.repository, ["add", "--", ...args.paths]);
  await git(args.repository, ["commit", "-m", args.message, "--", ...args.paths]);
  const summary = await git(args.repository, ["log", "-1", "--format=%h %s"]);
  if (!args.push) return `Commit créé : ${summary}.`;
  await git(args.repository, ["push"]);
  return `Commit créé et poussé : ${summary}.`;
}

const DESCRIPTION =
  "Publie dans le fil Pupitre un document que tu as créé. Formats : HTML, PDF, CSV, TSV, XLSX, DOCX, Markdown, TXT et JSON. "
  + "Utilise cet outil pour livrer un plan, un audit, un brainstorming, une approche "
  + "ou tout contenu visuel riche qui serait pénible en long Markdown. Le fichier doit "
  + "respecter une limite de 2 Mio pour les formats texte et 10 Mio pour PDF/Office, et être situé dans le projet courant ou dans le dossier "
  + "temporaire de l’OS. Pupitre l’affiche dans un aperçu "
  + "sandboxé, l’indexe, génère sa miniature et le conserve jusqu’à suppression explicite. "
  + "Passe delete_source=true pour supprimer l’original uniquement s’il est temporaire. "
  + "Dans un HTML, intègre chaque capture ou vidéo en data: URI base64 dans une balise <img> ou <video> : "
  + "Pupitre l’agrandit au clic et fait défiler tous les médias du document. L’aperçu bloque les médias chargés depuis une URL ; "
  + "une vidéo blob: ou un dessin dans un <canvas> ne s’agrandit pas.";

export function createPupitreServer(): McpServer {
  const server = new McpServer(
    { name: "pupitre", version: "0.1.0" },
    { instructions: "Publie les documents et les passages de code expliqués comme artefacts natifs de la conversation." },
  );
  const inputSchema = {
    path: z.string().describe("Chemin absolu du fichier à publier."),
    title: z.string().min(1).max(160).describe("Titre court affiché dans le fil."),
    summary: z.string().max(500).optional().describe("Résumé optionnel d’une phrase."),
    delete_source: z.boolean().optional().default(true).describe(
      "Supprime l’original après import seulement s’il est dans le dossier temporaire de l’OS.",
    ),
    conversation_id: z.string().optional().describe(
      "Conversation cible. À omettre normalement : Pupitre l’injecte dans l’environnement.",
    ),
  };
  const publish = async (args: {
    path: string; title: string; summary?: string; delete_source?: boolean; conversation_id?: string;
  }) => {
    try {
      const id = conversationId(args.conversation_id);
      const response = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(id)}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: args.path, title: args.title, summary: args.summary ?? null,
          deleteSource: args.delete_source ?? true,
        }),
      });
      if (response.status !== 201) throw new Error(await errorMessage(response));
      const document = await response.json() as {
        id: string; title: string; kind: string; expiresAt: string | null;
      };
      const kind = document.kind ?? (args.path.toLowerCase().endsWith(".pdf") ? "pdf" : "html");
      return text(`Document ${kind.toUpperCase()} publié et conservé dans Pupitre : ${document.title} (${document.id}).`);
    } catch (error) {
      return text(`Publication impossible : ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };
  server.registerTool("publish_document", {
    title: "Publier un document HTML ou PDF",
    description: DESCRIPTION,
    inputSchema,
  }, publish);
  // Alias conservé pour les conversations démarrées avant l'ajout du PDF.
  server.registerTool("publish_html_document", {
    title: "Publier un document HTML",
    description: DESCRIPTION,
    inputSchema,
  }, publish);
  server.registerTool("publish_code", {
    title: "Citer et expliquer un passage de code",
    description: "Publie un lecteur de code natif dans la conversation : fichier complet conservé, numéros de ligne, coloration syntaxique, passage ciblé et surligné. "
      + "Lis le fichier et vérifie ses lignes avant de publier. Un appel par passage à expliquer. Cite le code qui charge les secrets, jamais leurs valeurs.",
    inputSchema: {
      path: z.string().min(1).describe("Chemin absolu ou relatif au workspace de la conversation. Les worktrees de dépôts de la conversation sont acceptés, y compris via leur emplacement dans le monorepo (`apps/hapigator/...`)."),
      start_line: z.number().int().positive().describe("Première ligne du passage, inclusive, à partir de 1."),
      end_line: z.number().int().positive().describe("Dernière ligne du passage, inclusive."),
      title: z.string().min(1).max(160).describe("Titre court expliquant le rôle du passage."),
      explanation: z.string().min(1).max(4000).describe("Explication du code et de son lien avec la demande ou les changements."),
      highlights: z.array(z.object({ start_line: z.number().int().positive(), end_line: z.number().int().positive() }))
        .min(1).max(30).optional().describe("Lignes clés à surligner dans le passage. Par défaut : tout le passage."),
      conversation_id: z.string().optional(),
    },
  }, async (args) => {
    try {
      const response = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(conversationId(args.conversation_id))}/code-excerpts`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: args.path, title: args.title, explanation: args.explanation,
          startLine: args.start_line, endLine: args.end_line,
          highlights: args.highlights?.map((range) => ({ startLine: range.start_line, endLine: range.end_line })),
        }),
      });
      if (response.status !== 201) throw new Error(await errorMessage(response));
      const excerpt = await response.json() as { path: string; startLine: number; endLine: number };
      return text(`Passage publié dans Pupitre : ${excerpt.path}, lignes ${excerpt.startLine}–${excerpt.endLine}.`);
    } catch (error) {
      return text(`Publication du code impossible : ${error instanceof Error ? error.message : String(error)}`, true);
    }
  });
  server.registerTool("launch_project_command", {
    description: "Lance une commande nommée du projet courant dans le répertoire de la conversation et renvoie son état : `url` (le front), `urls` (adresses relevées dans la sortie, front en tête, `live` si le port écoute), `running`, `already_running` et les derniers logs. Attend jusqu’à 15 s qu’une adresse écoute. Une commande déjà lancée n’est pas relancée : son état est renvoyé tel quel.",
    inputSchema: { name: z.string() },
  }, async ({ name }: { name: string }) => {
    try {
      const launched = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(conversationId())}/launch-command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      if (!launched.ok) throw new Error(await errorMessage(launched));
      return text(JSON.stringify(await launched.json()));
    } catch (error) { return text(String(error), true); }
  });
  server.registerTool("read_sibling_conversation", {
    title: "Lire une conversation Pupitre liée",
    description: "Rend le titre, le résumé, le dernier débrief et les derniers échanges d’une autre conversation Pupitre liée au ticket courant.",
    inputSchema: {
      conversation_id: z.string().describe("Id de la conversation à lire."),
    },
  }, async (args: { conversation_id: string }) => {
    try {
      const source = conversationId();
      const url = new URL(`${baseUrl()}/api/conversations/${encodeURIComponent(args.conversation_id)}/brief`);
      url.searchParams.set("source", source);
      const response = await fetch(url);
      if (!response.ok) throw new Error(await errorMessage(response));
      const brief = await response.json() as ConversationBrief;
      return text(renderConversationBrief(brief));
    } catch (error) {
      return text(`Lecture impossible : ${error instanceof Error ? error.message : String(error)}`, true);
    }
  });
  server.registerTool("read_conversation", {
    title: "Lire une conversation Pupitre",
    description: "Lit n’importe quelle conversation Pupitre, tous projets confondus, désignée par son id ou par son titre (celui de la barre latérale). "
      + "Par défaut : titre, résumé, dernier débrief et derniers échanges. `full: true` rend la discussion complète. "
      + "Utilise-le quand l’utilisateur cite une conversation (« @[Titre] », un id ou un nom).",
    inputSchema: {
      conversation: z.string().min(1).describe("Id ou titre de la conversation."),
      full: z.boolean().optional().describe("Rendre la discussion complète plutôt que le brief."),
    },
  }, async (args: { conversation: string; full?: boolean }) => {
    try {
      const reference = args.conversation.trim();
      let target = reference;
      const direct = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(reference)}/brief`);
      if (direct.status === 404) {
        const url = new URL(`${baseUrl()}/api/conversation-references`);
        url.searchParams.set("q", reference);
        url.searchParams.set("limit", "8");
        const search = await fetch(url);
        if (!search.ok) throw new Error(await errorMessage(search));
        const matches = await search.json() as Array<{ id: string; title: string; project_name: string; updated_at: string }>;
        const exact = matches.filter((item) => item.title.trim().toLowerCase() === reference.toLowerCase());
        const chosen = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
        if (!chosen) {
          if (matches.length === 0) return text(`Aucune conversation Pupitre ne correspond à « ${reference} ».`, true);
          return text([
            `Plusieurs conversations correspondent à « ${reference} » ; relance avec l’id voulu :`,
            ...matches.map((item) => `- ${item.id} · « ${item.title} » (projet ${item.project_name}, ${item.updated_at})`),
          ].join("\n"));
        }
        target = chosen.id;
      } else if (!direct.ok) {
        throw new Error(await errorMessage(direct));
      } else if (!args.full) {
        return text(renderConversationBrief(await direct.json() as ConversationBrief));
      }
      if (args.full) {
        const response = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(target)}/discussion-document`);
        if (!response.ok) throw new Error(await errorMessage(response));
        const { contentMd } = await response.json() as { contentMd: string };
        return text(contentMd.length > FULL_DISCUSSION_MAX
          ? `[Début tronqué : ${contentMd.length - FULL_DISCUSSION_MAX} caractères omis]\n\n${contentMd.slice(-FULL_DISCUSSION_MAX)}`
          : contentMd);
      }
      const response = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(target)}/brief`);
      if (!response.ok) throw new Error(await errorMessage(response));
      return text(renderConversationBrief(await response.json() as ConversationBrief));
    } catch (error) {
      return text(`Lecture impossible : ${error instanceof Error ? error.message : String(error)}`, true);
    }
  });
  server.registerTool("add_todo", {
    title: "Ajouter une tâche à la pile Pupitre",
    description: "Ajoute une tâche au backlog du projet de cette conversation. À n’utiliser que si l’utilisateur le demande explicitement : n’ajoute jamais de tâche de ta propre initiative.",
    inputSchema: {
      title: z.string().min(1).describe("Titre court de la tâche."),
      message: z.string().min(1).describe("Consigne complète que l’agent recevra pour réaliser la tâche."),
    },
  }, async (args: { title: string; message: string }) => {
    try {
      const response = await fetch(`${baseUrl()}/api/todo-inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conversationId(), ...args }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const created = await response.json() as { title: string; project: string };
      return text(`Tâche ajoutée au backlog de ${created.project} : ${created.title}`);
    } catch (error) {
      return text(`Ajout impossible : ${error instanceof Error ? error.message : String(error)}`, true);
    }
  });
  server.registerTool("report_incident_triage", {
    title: "Rendre le triage d’un incident personnel",
    description: "Enregistre le verdict pour l’incident d’environnement lié à cette conversation.",
    inputSchema: {verdict:z.enum(["real_fixable","real_investigate","noise","uncertain"]),summary:z.string().min(1),evidence:z.array(z.string()).default([]),proposed_fix:z.string().optional()},
  }, async (report: {verdict:string;summary:string;evidence:string[];proposed_fix?:string}) => {
    try {
      const response=await fetch(`${baseUrl()}/api/personal-incidents/triage-report`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({conversationId:conversationId(),report})});
      if(!response.ok)throw new Error(await errorMessage(response));
      return text("Triage enregistré dans l’inbox d’incidents du projet.");
    }catch(error){return text(String(error),true);}
  });
  server.registerTool("report_sentry_triage", {
    title: "Rendre le verdict Scout Sentry",
    description: "Enregistre le verdict structuré du Scout pour l'issue Sentry liée à cette conversation.",
    inputSchema: {
      verdict: z.enum(["real_fixable", "real_investigate", "noise", "uncertain"]),
      summary: z.string().min(1),
      evidence: z.array(z.string()).default([]),
      proposed_fix: z.string().optional(),
    },
  }, async (args: { verdict: "real_fixable" | "real_investigate" | "noise" | "uncertain"; summary: string; evidence: string[]; proposed_fix?: string }) => {
    try {
      const id = conversationId();
      const response = await fetch(`${baseUrl()}/api/sentry/triages/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: id, verdict: args.verdict, report: args }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      return text("Verdict Scout enregistré dans l'inbox Sentry.");
    } catch (error) {
      return text(`Verdict impossible à enregistrer : ${error instanceof Error ? error.message : String(error)}`, true);
    }
  });
  server.registerTool("git_commit", {
    title: "Committer des fichiers précis",
    description: "Ajoute et committe exactement les fichiers listés, sans toucher aux autres changements du dépôt, "
      + "puis pousse la branche courante si push=true. Les chemins sont relatifs au dépôt ou absolus. "
      + "Utilise cet outil quand ta commande shell `git add` ou `git commit` est refusée.",
    inputSchema: {
      repository: z.string().describe("Chemin absolu du dépôt Git."),
      paths: z.array(z.string().min(1)).min(1).describe("Fichiers à committer, suppressions comprises."),
      message: z.string().min(1).describe("Message de commit complet."),
      push: z.boolean().optional().default(false).describe("Pousse la branche courante après le commit."),
    },
  }, async (args: { repository: string; paths: string[]; message: string; push?: boolean }) => {
    try {
      return text(await commitPaths(args));
    } catch (error) {
      return text(`Commit impossible : ${error instanceof Error ? error.message : String(error)}`, true);
    }
  });
  return server;
}

export async function runPupitreMcp(): Promise<void> {
  await createPupitreServer().connect(new StdioServerTransport());
}

if (import.meta.main) await runPupitreMcp();
