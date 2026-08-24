import { dataDir, openDb } from "./db";
import { MediaStore } from "./media";
import { ConversationRunner } from "./runner";
import { claimServer, ConversationEventBus, createServer } from "./server";
import { ConversationStore } from "./stores/conversations";
import { ProjectStore } from "./stores/projects";
import { PresetStore } from "./stores/presets";
import { SettingsStore } from "./stores/settings";
import { actionFormat } from "./response-format";
import { QuotaTracker } from "./quotas";
import { QuotaRefresher } from "./quota-refresh";
import { authenticateQuotaProvider } from "./quota-auth";
import { SubtaskRunner } from "./subtasks";
import { codexAppServer } from "./adapters/codex-app-server";
import { runConductorMcp } from "./conductor-mcp";
import { runPupitreMcp } from "./pupitre-mcp";
import { ReviewStore } from "./stores/reviews";
import { ReviewRunner } from "./reviews";
import { DebriefStore } from "./stores/debriefs";
import { DebriefRunner, generateWithAdapters } from "./debriefs";
import { GitProjectService } from "./git";
import { TestingStore } from "./stores/testing";
import { TesterRunner } from "./testing";
import { SkillInventory } from "./skills";
import { SkillSuggestionService } from "./skill-suggestions";
import { SkillComposer } from "./skill-composer";
import { WorkflowStore } from "./stores/workflows";
import { NotificationStore } from "./stores/notifications";
import { RoutineScheduler, RoutineStore } from "./routines";
import { SearchIndex } from "./search";
import { CostStore } from "./costs";
import { MemoryStore } from "./memory";
import { GamificationService } from "./gamification";
import { HtmlDocumentService } from "./html-documents";
import { ClickUpClient } from "./integrations/clickup";
import { GitLabClient, readGlabToken } from "./integrations/gitlab";
import { IntegrationsRefresher } from "./integrations/refresher";
import { IntegrationStore } from "./stores/integrations";
import { INTEGRATION_TOKENS_KEY } from "./stores/settings";
import { TicketStore } from "./stores/tickets";
import { DomainStore } from "./stores/domains";
import { ChangelogStore } from "./stores/changelog";
import { ChangelogService } from "./changelog";
import { IntegrationSecretStore } from "./stores/integration-secrets";
import { SentryStore } from "./stores/sentry";
import { SentryClient } from "./integrations/sentry";

/** 128 + SIGTERM, la convention shell pour « terminé par un signal ». */
const KILLED_EXIT_CODE = 143;

if (process.argv.includes("--pupitre-mcp")) {
  await runPupitreMcp();
} else if (process.argv.includes("--conductor-mcp")) {
  await runConductorMcp();
} else {
  const dir = dataDir();
  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const presets = new PresetStore(db);
  const settings = new SettingsStore(db);
  const conversations = new ConversationStore(db);
  conversations.backfillPresetIds(presets);
  conversations.sweepPendingHandoffs();
  const media = new MediaStore(dir);
  const events = new ConversationEventBus();
  const htmlDocuments = new HtmlDocumentService(
    db,
    dir,
    conversations,
    projects,
    events.broadcast,
  );
  htmlDocuments.sweepExpired();
  const quotas = new QuotaTracker(db);
  const quotaRefresher = new QuotaRefresher(quotas);
  const reviewStore = new ReviewStore(db);
  const skills = new SkillInventory(db, projects);
  skills.start();
  const skillSuggestions = new SkillSuggestionService(skills, projects, quotas);
  const skillComposer = new SkillComposer(skills, projects, quotas);
  const workflows = new WorkflowStore(db);
  const notifications = new NotificationStore(db);
  const routineStore = new RoutineStore(db);
  const search = new SearchIndex(db);
  const costs = new CostStore(db);
  const memory = new MemoryStore();
  const integrations = new IntegrationStore(db);
  const tickets = new TicketStore(db);
  const domains = new DomainStore(db);
  const integrationSecrets = new IntegrationSecretStore(db);
  const sentry = new SentryStore(db);
  const git = new GitProjectService(db, projects);
  const changelog = new ChangelogService(
    new ChangelogStore(db), conversations, projects, domains, git,
    (input) => generateWithAdapters(input, quotas),
  );
  const gamification = new GamificationService(db, projects, git);
  const integrationsRefresher = new IntegrationsRefresher(
    { integrations, tickets, conversations, projects, sentry, domains },
    {
      clickUpClient: () => {
        const token = settings.get<Record<string, string>>(INTEGRATION_TOKENS_KEY)?.clickup ?? null;
        return token ? new ClickUpClient(token) : null;
      },
      gitLabClient: (integration) => {
        const host = typeof integration.config.host === "string" ? integration.config.host : "";
        if (host.trim() === "") return null;
        const token = settings.get<Record<string, string>>(INTEGRATION_TOKENS_KEY)?.gitlab ?? readGlabToken(host);
        return token ? new GitLabClient({ host, token }) : null;
      },
      sentryClient: (integration) => {
        const token = integrationSecrets.get(integration.id, "token");
        const baseUrl = typeof integration.config.baseUrl === "string" ? integration.config.baseUrl : "https://sentry.io";
        return token ? new SentryClient({ baseUrl, token }) : null;
      },
    },
  );
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
    git,
    skills,
    (notification) => { notifications.create(notification); },
    () => {
      const seconds = settings.get<number>("longTaskThresholdSeconds") ?? 120;
      return Number.isFinite(seconds) && seconds >= 10 ? seconds * 1_000 : 120_000;
    },
    undefined,
    () => actionFormat(settings.get("actionFormat")),
    domains,
  );
  // Les sous-tâches ne prennent PAS le verrou de conversation du runner : elles
  // tournent en parallèle du tour parent qui les a demandées.
  const subtasks = new SubtaskRunner(db, conversations, projects, events.broadcast, quotas);
  const reviews = new ReviewRunner(
    reviewStore,
    projects,
    conversations,
    quotas,
    undefined,
    subtasks,
  );
  const debriefs = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    quotas,
    events.broadcast,
    undefined,
    runner.activity,
  );
  const testers = new TesterRunner(
    new TestingStore(db),
    conversations,
    projects,
    reviewStore,
    quotas,
    events.broadcast,
    subtasks,
    undefined,
    runner.activity,
    media,
  );
  const routines = new RoutineScheduler(
    routineStore,
    workflows,
    presets,
    projects,
    conversations,
    runner,
    notifications,
  );
  // Arrêt propre partagé : éviction par un sidecar plus récent (POST
  // /api/shutdown), SIGTERM de Tauri à la fermeture de l'app, Ctrl-C en dev.
  // Sans lui, l'app-server codex et sa flotte de serveurs MCP survivent en
  // orphelins — et un vieux sidecar qui garde le port fait tourner l'UI sur du
  // code périmé.
  let stopping = false;
  const htmlDocumentSweepTimer = setInterval(
    () => htmlDocuments.sweepExpired(),
    15 * 60_000,
  );
  htmlDocumentSweepTimer.unref?.();
  // Le code de sortie porte la cause de l'arrêt, parce que le superviseur Tauri
  // en dépend : un 0 signifie « cède la place, ne me relance pas » (éviction par
  // une instance plus récente), tout le reste vaut « je suis mort sans l'avoir
  // demandé, relance-moi ». Sortir 0 sur un SIGTERM externe laissait l'app sans
  // backend jusqu'au prochain lancement.
  const shutdownGracefully = (cause: "requested" | "signal") => {
    if (stopping) return;
    stopping = true;
    try {
      quotaRefresher.stop();
      integrationsRefresher.stop();
      clearInterval(htmlDocumentSweepTimer);
      codexAppServer.shutdown();
    } finally {
      process.exit(cause === "requested" ? 0 : KILLED_EXIT_CODE);
    }
  };
  process.on("SIGTERM", () => shutdownGracefully("signal"));
  process.on("SIGINT", () => shutdownGracefully("signal"));

  server = await claimServer(() => createServer({
    port,
    shutdown: () => shutdownGracefully("requested"),
    projects,
    conversations,
    media,
    runner,
    events,
    quotas,
    quotaRefresher,
    authenticateQuotaProvider,
    subtasks,
    presets,
    settings,
    reviews,
    debriefs,
    git,
    testers,
    skills,
    skillSuggestions,
    skillComposer,
    workflows,
    routineStore,
    routines,
    notifications,
    search,
    costs,
    memory,
    integrations,
    tickets,
    domains,
    changelog,
    integrationSecrets,
    sentry,
    integrationsRefresher,
    gamification,
    htmlDocuments,
  }), port);
  routines.start();

  // Les deux relevés de quota sont des lectures gratuites : on part d'un état
  // frais et on le tient à jour en fond (cf. QuotaRefresher).
  quotaRefresher.start();
  integrationsRefresher.start();

  console.log(`pupitre sidecar prêt sur http://localhost:${server.port}`);
}
