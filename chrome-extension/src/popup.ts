import type { Destinations, Resolution } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const errorBox = $("error");
let tab: any;
let resolution: Resolution | null = null;
let destinations: Destinations | null = null;

async function send(message: unknown): Promise<any> {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

function showError(error: unknown) { errorBox.textContent = error instanceof Error ? error.message : String(error); }

function updateConversations() {
  if (!destinations) return;
  const selectedBranch = ($("branch") as HTMLSelectElement).value;
  const compatible = destinations.conversations.filter((item) =>
    item.created_on_branch === selectedBranch
    && (selectedBranch !== destinations!.currentBranch || item.worktree_path === null));
  ($("conversation") as HTMLSelectElement).replaceChildren(
    new Option("Nouvelle conversation automatique", ""),
    ...compatible.map((item) => new Option(item.title, item.id)),
  );
}

async function load() {
  errorBox.textContent = "";
  ($("send") as HTMLButtonElement).disabled = true;
  const stored = await send({ type: "GET_STATE" });
  if (!stored.paired) {
    $("connection").hidden = false;
    status.textContent = "Non appairé";
    return;
  }
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) throw new Error("Aucun onglet local actif.");
  const url = new URL(tab.url);
  const resolved = await send({ type: "RESOLVE", origin: url.origin, pathname: url.pathname }) as Resolution;
  resolution = resolved;
  $("feedback").hidden = false;
  if (resolved.status !== "resolved") {
    status.textContent = "Projet à associer";
    $("association").hidden = false;
    const select = $("project-choice") as HTMLSelectElement;
    select.replaceChildren(...resolved.projects.map((project) => new Option(project.name, project.id)));
    return;
  }
  status.textContent = "Connecté";
  $("project").textContent = resolved.project.name;
  const loadedDestinations = resolved.destinations
    ?? await send({ type: "DESTINATIONS", projectId: resolved.project.id }) as Destinations;
  destinations = loadedDestinations;
  $("destination").hidden = false;
  const branch = $("branch") as HTMLSelectElement;
  branch.replaceChildren(...loadedDestinations.branches.map((name) => new Option(name, name, false, name === loadedDestinations.currentBranch)));
  updateConversations();
  ($("send") as HTMLButtonElement).disabled = false;
  const annotations = stored.carts?.[resolved.project.id] ?? [];
  $("annotations").replaceChildren(...annotations.map((item: any) => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `${item.number}. ${item.instruction}`;
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "Retirer";
    remove.addEventListener("click", () => void send({ type: "REMOVE_ANNOTATION", projectId: resolved.project.id, number: item.number }).then(load).catch(showError));
    li.append(text, remove);
    return li;
  }));
}

$("save-connection").addEventListener("click", () => void send({
  type: "SAVE_CONNECTION",
  token: ($("token") as HTMLInputElement).value,
  port: ($("port") as HTMLInputElement).value,
}).then(() => location.reload()).catch(showError));

$("branch").addEventListener("change", updateConversations);

$("inspect").addEventListener("click", () => void (async () => {
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "START_INSPECTION" });
  window.close();
})().catch(showError));

$("associate").addEventListener("click", () => void (async () => {
  if (!tab?.url) return;
  const url = new URL(tab.url);
  await send({ type: "ASSOCIATE", origin: url.origin, pathname: url.pathname, projectId: ($("project-choice") as HTMLSelectElement).value });
  location.reload();
})().catch(showError));

$("send").addEventListener("click", () => void (async () => {
  if (resolution?.status !== "resolved" || !tab?.url) return;
  const page = await chrome.tabs.sendMessage(tab.id, { type: "PAGE_INFO" });
  const result = await send({
    type: "SUBMIT",
    projectId: resolution.project.id,
    branch: ($("branch") as HTMLSelectElement).value,
    conversationId: ($("conversation") as HTMLSelectElement).value,
    generalInstruction: ($("instruction") as HTMLTextAreaElement).value.trim(),
    page,
  });
  status.textContent = `Envoyé · ${result.conversationId.slice(0, 8)}`;
  await load();
})().catch(showError));

void load().catch(showError);
