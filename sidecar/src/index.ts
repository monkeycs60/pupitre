import { dataDir, openDb } from "./db";
import { MediaStore } from "./media";
import { ConversationRunner } from "./runner";
import { ConversationEventBus, createServer } from "./server";
import { ConversationStore } from "./stores/conversations";
import { ProjectStore } from "./stores/projects";
import { PresetStore } from "./stores/presets";
import { SettingsStore } from "./stores/settings";
import { QuotaTracker } from "./quotas";
import { SubtaskRunner } from "./subtasks";
import { codexAppServer } from "./adapters/codex-app-server";
import { runConductorMcp } from "./conductor-mcp";

if (process.argv.includes("--conductor-mcp")) {
  await runConductorMcp();
} else {
  const dir = dataDir();
  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const presets = new PresetStore(db);
  const settings = new SettingsStore(db);
  const conversations = new ConversationStore(db);
  const media = new MediaStore(dir);
  const events = new ConversationEventBus();
  const quotas = new QuotaTracker(db);
  const configuredPort = process.env.PUPITRE_PORT;
  const port = configuredPort === undefined ? 4820 : Number(configuredPort);
  if (configuredPort?.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PUPITRE_PORT invalide");
  }

  let server: ReturnType<typeof createServer>;
  const runner = new ConversationRunner(
    conversations,
    projects,
    media,
    events.broadcast,
    quotas,
    // Résolu à chaque tour : `server` n'existe qu'après la construction du runner.
    () => server.port ?? port,
  );
  // Les sous-tâches ne prennent PAS le verrou de conversation du runner : elles
  // tournent en parallèle du tour parent qui les a demandées.
  const subtasks = new SubtaskRunner(db, conversations, projects, events.broadcast, quotas);
  server = createServer({
    port,
    projects,
    conversations,
    media,
    runner,
    events,
    quotas,
    subtasks,
    presets,
    settings,
  });

  // Si l'app-server codex tourne déjà, on part avec un état de quota frais.
  void codexAppServer.readRateLimits()
    .then((rateLimits) => {
      if (rateLimits) quotas.ingestPayload("codex", rateLimits);
    })
    .catch(() => {});

  console.log(`pupitre sidecar prêt sur http://localhost:${server.port}`);
}
