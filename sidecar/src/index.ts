import { openDb } from "./db";
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
import { claudeSessions } from "./adapters/claude-session";
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
import { SkillComposer } from "./skill-composer";
import { WorkflowStore } from "./stores/workflows";
import { NotificationStore } from "./stores/notifications";
import { RoutineScheduler, RoutineStore } from "./routines";
import { SearchIndex } from "./search";
import { CostStore } from "./costs";
import { MemoryStore } from "./memory";
import { TimeTrackingService, HEARTBEAT_MS } from "./time-tracking";
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
import { ProblemStore } from "./stores/problems";
import { ProblemMissionStore } from "./stores/problem-missions";
import { ProblemService } from "./problems";
import { backgroundJobsEnabled, readInstance } from "./instance";

/** 128 + SIGTERM, la convention shell pour « terminé par un signal ». */
const KILLED_EXIT_CODE = 143;

if (process.argv.includes("--pupitre-mcp")) {
  await runPupitreMcp();
} else if (process.argv.includes("--conductor-mcp")) {
  await runConductorMcp();
} else {
  const instance = readInstance();
  const dir = instance.dataDir;
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
  const problemStore = new ProblemStore(db);
  const problemMissions = new ProblemMissionStore(db);
  const problems = new ProblemService(
    problemStore,
    projects,
    tickets,
    (input) => generateWithAdapters(input, quotas),
  );
  const git = new GitProjectService(db, projects);
  const changelog = new ChangelogService(
    new ChangelogStore(db), projects, domains,
    (input) => generateWithAdapters(input, quotas),
  );
  const closeProblemsFromCommits = (
    projectId: string,
    commits: Array<{ sha: string; message?: string; subject?: string }>,
  ) => {
    for (const commit of commits) {
      const message = commit.message ?? commit.subject;
      if (message) problems.closeFromCommit(projectId, message, commit.sha);
    }
  };
  git.subscribeCommits((projectId, shas) => {
    closeProblemsFromCommits(projectId, shas.map((sha) => ({
      sha,
      message: git.commitMessage(projectId, sha),
    })));
  });
  changelog.subscribeCommits(closeProblemsFromCommits);
  const time = new TimeTrackingService(db, projects, git);
  // Reprise d'historique : exacte pour les tours, approchée pour la présence.
  // Ne s'exécute qu'une fois, puis se marque terminée dans `settings`.
  const backfilled = time.backfill();
  if (backfilled) {
    console.log(`[temps] historique repris : ${Math.round(backfilled.presenceMs / 60_000)} min de présence sur ${backfilled.days} jours`);
  }
  // Le battement du sidecar est le seul témoin fiable d'une veille machine :
  // l'UI, elle, ne tourne que fenêtre au premier plan.
  time.heartbeat();
  setInterval(() => {
    const suspension = time.heartbeat();
    if (suspension) {
      console.log(`[temps] suspension de ${Math.round((suspension.end - suspension.start) / 60_000)} min retranchée des tours`);
    }
  }, HEARTBEAT_MS).unref?.();
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
  const port = instance.port;

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
    (conversationId, review) => {
      const event = {
        type: "review-report-ref" as const,
        reviewId: review.id,
        createdAt: review.updated_at,
      };
      const id = conversations.appendEvent(conversationId, event);
      events.broadcast(conversationId, { ...event, id });
    },
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
  // Sans lui, l'app-server codex, les tours provider en vol et leurs flottes de
  // serveurs MCP survivent en orphelins — et un vieux sidecar qui garde le port
  // fait tourner l'UI sur du code périmé.
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
      changelog.stop();
      clearInterval(htmlDocumentSweepTimer);
      runner.abortAll();
      claudeSessions.shutdown();
      codexAppServer.shutdown();
    } finally {
      process.exit(cause === "requested" ? 0 : KILLED_EXIT_CODE);
    }
  };
  process.on("SIGTERM", () => shutdownGracefully("signal"));
  process.on("SIGINT", () => shutdownGracefully("signal"));

  server = await claimServer(() => createServer({
    port,
    instance,
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
    problemStore,
    problemMissions,
    problems,
    integrationSecrets,
    sentry,
    integrationsRefresher,
    time,
    htmlDocuments,
  }), port);
  void problems.resume();
  if (backgroundJobsEnabled()) {
    routines.start();
    changelog.start();
    quotaRefresher.start();
    integrationsRefresher.start();
  } else {
    console.log("instance dev : tâches de fond désactivées (PUPITRE_BACKGROUND_JOBS=on pour les activer)");
  }

  console.log(`pupitre sidecar prêt sur http://localhost:${server.port}`);
}
