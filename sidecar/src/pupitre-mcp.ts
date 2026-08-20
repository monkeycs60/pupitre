#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
  return `http://127.0.0.1:${numberFromEnv("PUPITRE_PORT", 4820)}`;
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

const DESCRIPTION =
  "Publie dans le fil Pupitre un document HTML autonome ou un PDF que tu as créé. "
  + "Utilise cet outil pour livrer un plan, un audit, un brainstorming, une approche "
  + "ou tout contenu visuel riche qui serait pénible en long Markdown. Le fichier doit "
  + "être un .html/.htm UTF-8 autonome (2 Mio max) ou un .pdf (10 Mio max), situé dans le projet courant ou dans le dossier "
  + "temporaire de l’OS. Pupitre l’affiche dans un aperçu "
  + "sandboxé, l’indexe, génère sa miniature et le conserve jusqu’à suppression explicite. "
  + "Passe delete_source=true pour supprimer l’original uniquement s’il est temporaire.";

export function createPupitreServer(): McpServer {
  const server = new McpServer(
    { name: "pupitre", version: "0.1.0" },
    { instructions: "Publie les livrables HTML et PDF comme artefacts natifs de la conversation." },
  );
  const inputSchema = {
    path: z.string().describe("Chemin absolu du fichier .html, .htm ou .pdf à publier."),
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
        id: string; title: string; kind: "html" | "pdf"; expiresAt: string | null;
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
  return server;
}

export async function runPupitreMcp(): Promise<void> {
  await createPupitreServer().connect(new StdioServerTransport());
}

if (import.meta.main) await runPupitreMcp();
