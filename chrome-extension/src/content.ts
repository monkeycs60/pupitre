import { inspectElement } from "./dom";
import { locateAnnotation } from "./overlay";
import type { Annotation, Destinations, Resolution } from "./types";

let active = false;
let projectId: string | null = null;
let destinations: Destinations | null = null;
let annotations: Annotation[] = [];
let hoveredNumber: number | null = null;
let panelCollapsed = false;
const markers = new Map<number, HTMLElement>();
const boxes = new Map<number, HTMLElement>();

const overlay = document.createElement("div");
overlay.id = "pupitre-visual-feedback-root";
const shadow = overlay.attachShadow({ mode: "closed" });
document.documentElement.append(overlay);
const style = document.createElement("style");
style.textContent = `
.highlight,.annotation-box{position:fixed;box-sizing:border-box;border:2px solid #e85d3f;background:rgba(232,93,63,.06);pointer-events:none}.annotation-box.focused{border-width:3px;background:rgba(232,93,63,.12)}
.marker{position:fixed;display:grid;place-items:center;box-sizing:border-box;width:24px;height:24px;margin:-12px 0 0 -12px;padding:0;border:2px solid white;border-radius:50%;background:#d94f32;color:white;font:700 12px/1 ui-sans-serif,system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.3);pointer-events:auto;cursor:help}.marker.focused{width:28px;height:28px;margin:-14px 0 0 -14px;padding:0;background:#bd3f27}
.bubble,.tooltip,.panel{color:#f4efe9;background:#1d1c1a;border:1px solid #4b4640;font:13px/1.4 ui-sans-serif,system-ui,sans-serif}.bubble{position:fixed;width:280px;padding:10px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:auto}.bubble textarea,.panel textarea,.panel select{box-sizing:border-box;width:100%;padding:8px;color:inherit;background:#292724;border:1px solid #57514a;border-radius:5px;font:inherit}.bubble textarea{min-height:72px;resize:vertical}
.actions{display:flex;justify-content:flex-end;gap:7px;margin-top:8px}button{padding:7px 9px;border:1px solid #5f5851;border-radius:5px;background:transparent;color:inherit;font:600 12px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}button.primary{border-color:#d95d3f;background:#d95d3f;color:white}button:disabled{cursor:wait;opacity:.45}
.tooltip{position:fixed;z-index:3;max-width:280px;padding:7px 9px;border-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none}.panel{position:fixed;right:12px;top:12px;width:300px;max-height:calc(100vh - 24px);border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.24);pointer-events:auto;overflow:auto}.panel.collapsed{width:auto;overflow:visible}.panel.collapsed .panel-body{display:none}
.panel-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #3b3733}.panel-header strong{font-size:13px}.panel-header button{padding:4px 7px}.panel-body{padding:10px 12px}.panel-list{display:grid;gap:4px;margin:0 0 10px;padding:0;list-style:none}.panel-item{display:grid;grid-template-columns:24px 1fr auto;gap:7px;align-items:start;padding:7px 0;border-bottom:1px solid #302d2a}.panel-item.focused{color:#fff}.panel-item.missing{opacity:.55}.panel-number{color:#ff947d;font-weight:700}.panel-text{overflow-wrap:anywhere}.remove{padding:2px 4px;border:0;color:#aaa39b}.field{display:grid;gap:4px;margin:8px 0;color:#c9c2ba;font-size:11px}.panel textarea{min-height:54px;resize:vertical}.panel-status{min-height:18px;margin:7px 0 0;color:#ff947d;font-size:11px}`;
shadow.append(style);

const highlight = document.createElement("div");
highlight.className = "highlight";
shadow.append(highlight);
const tooltip = document.createElement("div");
tooltip.className = "tooltip";
tooltip.hidden = true;
shadow.append(tooltip);

const panel = document.createElement("aside");
panel.className = "panel";
panel.hidden = true;
const panelHeader = document.createElement("div");
panelHeader.className = "panel-header";
const panelTitle = document.createElement("strong");
const collapseButton = document.createElement("button");
collapseButton.title = "Replier le panier";
const panelBody = document.createElement("div");
panelBody.className = "panel-body";
const panelList = document.createElement("ol");
panelList.className = "panel-list";

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const element = document.createElement("label");
  element.className = "field";
  element.append(label, control);
  return element;
}

const branchSelect = document.createElement("select");
const conversationSelect = document.createElement("select");
const generalInstruction = document.createElement("textarea");
const panelActions = document.createElement("div");
panelActions.className = "actions";
const annotateButton = document.createElement("button");
annotateButton.textContent = "Annoter";
const submitButton = document.createElement("button");
submitButton.className = "primary";
submitButton.textContent = "Envoyer à Pupitre";
const panelStatus = document.createElement("p");
panelStatus.className = "panel-status";
panelActions.append(annotateButton, submitButton);
panelBody.append(panelList, field("Branche", branchSelect), field("Conversation", conversationSelect), field("Consigne générale", generalInstruction), panelActions, panelStatus);
panelHeader.append(panelTitle, collapseButton);
panel.append(panelHeader, panelBody);
shadow.append(panel);

function placeHighlight(element: Element | null) {
  if (!element) { highlight.style.display = "none"; return; }
  const rect = element.getBoundingClientRect();
  Object.assign(highlight.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

async function resolveProject(): Promise<{ id: string; destinations?: Destinations }> {
  const resolution = await chrome.runtime.sendMessage({ type: "RESOLVE", origin: location.origin, pathname: location.pathname }) as Resolution & { error?: string };
  if (resolution.error) throw new Error(resolution.error);
  if (resolution.status !== "resolved") throw new Error("Associe d’abord cette origine à un projet depuis le panneau Pupitre.");
  return { id: resolution.project.id, destinations: resolution.destinations };
}

function start() { active = true; document.documentElement.style.cursor = "crosshair"; }
function stop() { active = false; placeHighlight(null); document.documentElement.style.cursor = ""; }

function locate(number: number) {
  const annotation = annotations.find((item) => item.number === number);
  return annotation ? locateAnnotation(annotation) : null;
}

function setHovered(number: number | null, x = 20, y = 20) {
  hoveredNumber = number;
  for (const [key, marker] of markers) marker.classList.toggle("focused", key === number);
  for (const [key, box] of boxes) box.classList.toggle("focused", key === number);
  for (const item of panelList.querySelectorAll<HTMLElement>(".panel-item")) item.classList.toggle("focused", Number(item.dataset.number) === number);
  const annotation = annotations.find((item) => item.number === number);
  tooltip.hidden = !annotation;
  if (annotation) {
    tooltip.textContent = annotation.instruction;
    Object.assign(tooltip.style, { left: `${Math.min(innerWidth - 300, Math.max(8, x + 12))}px`, top: `${Math.min(innerHeight - 60, Math.max(8, y + 12))}px` });
  }
}

function positionOverlays() {
  for (const annotation of annotations) {
    const marker = markers.get(annotation.number);
    const box = boxes.get(annotation.number);
    const position = locateAnnotation(annotation);
    if (!marker || !box) continue;
    marker.hidden = !position;
    box.hidden = !position;
    if (!position) continue;
    Object.assign(box.style, { left: `${position.left}px`, top: `${position.top}px`, width: `${position.width}px`, height: `${position.height}px` });
    Object.assign(marker.style, { left: `${position.pointX}px`, top: `${position.pointY}px` });
  }
  for (const item of panelList.querySelectorAll<HTMLElement>(".panel-item")) item.classList.toggle("missing", locate(Number(item.dataset.number)) === null);
}

function updateConversationOptions(preferred = conversationSelect.value) {
  const compatible = destinations?.conversations.filter((item) => item.created_on_branch === branchSelect.value
    && (branchSelect.value !== destinations!.currentBranch || item.worktree_path === null)) ?? [];
  conversationSelect.replaceChildren(new Option("Nouvelle conversation", ""), ...compatible.map((item) => new Option(item.title, item.id)));
  if (compatible.some((item) => item.id === preferred)) conversationSelect.value = preferred;
}

function renderPanel() {
  panel.hidden = annotations.length === 0;
  panel.classList.toggle("collapsed", panelCollapsed);
  panelTitle.textContent = panelCollapsed ? `Pupitre · ${annotations.length}` : `Panier Pupitre · ${annotations.length}`;
  collapseButton.textContent = panelCollapsed ? "Ouvrir" : "Replier";
  panelList.replaceChildren(...annotations.map((annotation) => {
    const item = document.createElement("li");
    item.className = "panel-item";
    item.dataset.number = String(annotation.number);
    const number = document.createElement("span");
    number.className = "panel-number";
    number.textContent = String(annotation.number);
    const text = document.createElement("span");
    text.className = "panel-text";
    text.textContent = annotation.instruction;
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "Retirer";
    remove.addEventListener("click", () => projectId && void chrome.runtime.sendMessage({ type: "REMOVE_ANNOTATION", projectId, number: annotation.number }));
    item.addEventListener("mouseenter", (event) => setHovered(annotation.number, event.clientX, event.clientY));
    item.addEventListener("mouseleave", () => setHovered(null));
    item.append(number, text, remove);
    return item;
  }));
  submitButton.disabled = !destinations || !branchSelect.value;
}

function renderAnnotations(next: Annotation[]) {
  annotations = next;
  setHovered(null);
  for (const marker of markers.values()) marker.remove();
  for (const box of boxes.values()) box.remove();
  markers.clear();
  boxes.clear();
  for (const annotation of annotations) {
    const box = document.createElement("div");
    box.className = "annotation-box";
    const marker = document.createElement("button");
    marker.className = "marker";
    marker.textContent = String(annotation.number);
    marker.addEventListener("mouseenter", (event) => setHovered(annotation.number, event.clientX, event.clientY));
    marker.addEventListener("mouseleave", () => setHovered(null));
    shadow.append(box, marker);
    boxes.set(annotation.number, box);
    markers.set(annotation.number, marker);
  }
  renderPanel();
  positionOverlays();
}

async function restoreAnnotations() {
  try {
    const resolved = await resolveProject();
    projectId = resolved.id;
    const loadedDestinations: Destinations = resolved.destinations
      ?? await chrome.runtime.sendMessage({ type: "DESTINATIONS", projectId });
    destinations = loadedDestinations;
    const stored = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    const savedBranch = stored.branches?.[projectId] ?? loadedDestinations.currentBranch;
    branchSelect.replaceChildren(...loadedDestinations.branches.map((name) => new Option(name, name, false, name === savedBranch)));
    updateConversationOptions(stored.conversations?.[projectId] ?? "");
    renderAnnotations(stored.carts?.[projectId] ?? []);
  } catch {}
}

function askInstruction(x: number, y: number): Promise<string | null> {
  return new Promise((resolve) => {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    Object.assign(bubble.style, { left: `${Math.min(innerWidth - 300, Math.max(10, x + 14))}px`, top: `${Math.min(innerHeight - 150, Math.max(10, y + 14))}px` });
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Décris la correction…";
    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Annuler";
    const add = document.createElement("button");
    add.className = "primary";
    add.textContent = "Ajouter au panier";
    const finish = (accepted: boolean) => {
      const instruction = textarea.value.trim();
      if (accepted && !instruction) { textarea.focus(); return; }
      bubble.remove();
      resolve(accepted ? instruction : null);
    };
    cancel.addEventListener("click", () => finish(false));
    add.addEventListener("click", () => finish(true));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish(false);
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) finish(true);
    });
    actions.append(cancel, add);
    bubble.append(textarea, actions);
    shadow.append(bubble);
    textarea.focus();
  });
}

collapseButton.addEventListener("click", () => { panelCollapsed = !panelCollapsed; renderPanel(); });
annotateButton.addEventListener("click", start);
branchSelect.addEventListener("change", () => {
  updateConversationOptions("");
  if (projectId) void chrome.runtime.sendMessage({ type: "SAVE_DESTINATION", projectId, branch: branchSelect.value, conversationId: "" });
});
conversationSelect.addEventListener("change", () => {
  if (projectId) void chrome.runtime.sendMessage({ type: "SAVE_DESTINATION", projectId, branch: branchSelect.value, conversationId: conversationSelect.value });
});
submitButton.addEventListener("click", () => void (async () => {
  if (!projectId || !branchSelect.value) return;
  submitButton.disabled = true;
  panelStatus.textContent = "Envoi…";
  const response = await chrome.runtime.sendMessage({ type: "SUBMIT", projectId, branch: branchSelect.value, conversationId: conversationSelect.value,
    generalInstruction: generalInstruction.value.trim(), page: { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio } } });
  if (response.error) throw new Error(response.error);
  panelStatus.textContent = "Envoyé à Pupitre";
})().catch((error) => { panelStatus.textContent = error instanceof Error ? error.message : String(error); submitButton.disabled = false; }));

document.addEventListener("mousemove", (event) => {
  if (active) {
    const target = event.target instanceof Element ? event.target : null;
    if (target && target !== overlay) placeHighlight(target);
    return;
  }
  if ((event.composedPath?.() ?? []).includes(overlay)) return;
  const annotation = annotations.find((item) => {
    const rect = locateAnnotation(item);
    return rect && event.clientX >= rect.left && event.clientX <= rect.left + rect.width && event.clientY >= rect.top && event.clientY <= rect.top + rect.height;
  });
  if (annotation?.number !== hoveredNumber) setHovered(annotation?.number ?? null, event.clientX, event.clientY);
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") stop();
  if (event.altKey && event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); start(); }
}, true);

document.addEventListener("click", async (event) => {
  if (!active || !(event.target instanceof Element) || event.target === overlay) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const element = event.target;
  stop();
  try {
    const resolved = await resolveProject();
    projectId = resolved.id;
    destinations ??= resolved.destinations ?? null;
    const instruction = await askInstruction(event.clientX, event.clientY);
    if (!instruction) return;
    const annotation = { ...inspectElement(element, { x: event.clientX, y: event.clientY }), instruction };
    const stored = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    const previous = stored.carts?.[projectId] ?? [];
    renderAnnotations([...previous, { ...annotation, number: previous.length + 1 }]);
    const response = await chrome.runtime.sendMessage({ type: "ADD_ANNOTATION", projectId, annotation });
    if (response.error) {
      renderAnnotations(previous);
      throw new Error(response.error);
    }
    if (destinations && branchSelect.options.length === 0) {
      branchSelect.replaceChildren(...destinations.branches.map((name) => new Option(name, name, false, name === destinations!.currentBranch)));
      updateConversationOptions();
    }
    panelCollapsed = false;
    renderAnnotations(response.annotations);
  } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
}, true);

chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (value: any) => void) => {
  if (message.type === "START_INSPECTION") start();
  if (message.type === "PAGE_INFO") sendResponse({ url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio } });
  if (message.type === "SYNC_MARKERS" && message.projectId === projectId) renderAnnotations(message.annotations ?? []);
  if (message.type === "CLEAR_MARKERS" && (!projectId || message.projectId === projectId)) renderAnnotations([]);
});

let positionFrame = 0;
function schedulePosition() { cancelAnimationFrame(positionFrame); positionFrame = requestAnimationFrame(positionOverlays); }
addEventListener("scroll", schedulePosition, { passive: true, capture: true });
addEventListener("resize", schedulePosition, { passive: true });
new MutationObserver(schedulePosition).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
void restoreAnnotations();
