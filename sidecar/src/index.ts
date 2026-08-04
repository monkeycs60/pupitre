import { dataDir, openDb } from "./db";
import { MediaStore } from "./media";
import { ConversationRunner } from "./runner";
import { ConversationEventBus, createServer } from "./server";
import { ConversationStore } from "./stores/conversations";
import { ProjectStore } from "./stores/projects";

const dir = dataDir();
const db = openDb(dir);
const projects = new ProjectStore(db);
const conversations = new ConversationStore(db);
const media = new MediaStore(dir);
const events = new ConversationEventBus();
const runner = new ConversationRunner(
  conversations,
  projects,
  media,
  events.broadcast,
);
const configuredPort = process.env.PUPITRE_PORT;
const port = configuredPort === undefined ? 4820 : Number(configuredPort);
if (configuredPort?.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PUPITRE_PORT invalide");
}

const server = createServer({
  port,
  projects,
  conversations,
  media,
  runner,
  events,
});

console.log(`pupitre sidecar prêt sur http://localhost:${server.port}`);
