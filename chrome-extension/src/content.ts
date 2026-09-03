import { inspectElement } from "./dom";
import type { Annotation } from "./types";

let active = false;
let highlighted: Element | null = null;
let projectId: string | null = null;
const markers = new Map<number, HTMLElement>();
let markerAnnotations: Annotation[] = [];

const overlay = document.createElement("div");
overlay.id = "pupitre-visual-feedback-root";
const shadow = overlay.attachShadow({ mode: "closed" });
document.documentElement.append(overlay);
const style = document.createElement("style");
style.textContent = `.highlight{position:fixed;box-sizing:border-box;border:2px solid #e85d3f;background:rgba(232,93,63,.08);pointer-events:none}.marker{position:fixed;width:24px;height:24px;margin:-12px 0 0 -12px;border:2px solid white;border-radius:50%;background:#d94f32;color:white;font:700 12px/20px system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.3);pointer-events:auto}.bubble{position:fixed;width:280px;padding:10px;background:#1d1c1a;color:#f4efe9;border:1px solid #4b4640;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:auto;font:13px/1.4 system-ui,sans-serif}.bubble textarea{box-sizing:border-box;width:100%;min-height:72px;padding:8px;resize:vertical;color:inherit;background:#292724;border:1px solid #57514a;border-radius:5px;font:inherit}.bubble .actions{display:flex;justify-content:flex-end;gap:7px;margin-top:8px}.bubble button{padding:7px 9px;border:1px solid #5f5851;border-radius:5px;background:transparent;color:inherit;font:600 12px/1 system-ui,sans-serif}.bubble button.primary{border-color:#d95d3f;background:#d95d3f;color:white}`;
shadow.append(style);

const highlight = document.createElement("div");
highlight.className = "highlight";
shadow.append(highlight);

function placeHighlight(element: Element | null) {
  highlighted = element;
  if (!element) { highlight.style.display = "none"; return; }
  const rect = element.getBoundingClientRect();
  Object.assign(highlight.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

async function resolveProject(): Promise<string> {
  const resolution = await chrome.runtime.sendMessage({ type: "RESOLVE", origin: location.origin, pathname: location.pathname });
  if (resolution.error) throw new Error(resolution.error);
  if (resolution.status !== "resolved") throw new Error("Associe d’abord cette origine à un projet depuis le panneau Pupitre.");
  return resolution.project.id;
}

function start() {
  active = true;
  document.documentElement.style.cursor = "crosshair";
}

function stop() {
  active = false;
  placeHighlight(null);
  document.documentElement.style.cursor = "";
}

function renderMarkers(annotations: Annotation[]) {
  markerAnnotations = annotations;
  for (const marker of markers.values()) marker.remove();
  markers.clear();
  for (const annotation of annotations) {
    const marker = document.createElement("button");
    marker.className = "marker";
    marker.textContent = String(annotation.number);
    marker.title = annotation.instruction;
    const x = annotation.point.documentX ?? annotation.point.x + scrollX;
    const y = annotation.point.documentY ?? annotation.point.y + scrollY;
    Object.assign(marker.style, { left: `${x - scrollX}px`, top: `${y - scrollY}px` });
    shadow.append(marker);
    markers.set(annotation.number, marker);
  }
}

function repositionMarkers() {
  for (const annotation of markerAnnotations) {
    const marker = markers.get(annotation.number);
    if (!marker) continue;
    const x = annotation.point.documentX ?? annotation.point.x + scrollX;
    const y = annotation.point.documentY ?? annotation.point.y + scrollY;
    Object.assign(marker.style, { left: `${x - scrollX}px`, top: `${y - scrollY}px` });
  }
}

async function restoreMarkers() {
  try {
    projectId = await resolveProject();
    const stored = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    renderMarkers(stored.carts?.[projectId] ?? []);
  } catch {}
}

function askInstruction(x: number, y: number): Promise<{ instruction: string; send: boolean } | null> {
  return new Promise((resolve) => {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    Object.assign(bubble.style, {
      left: `${Math.min(innerWidth - 300, Math.max(10, x + 14))}px`,
      top: `${Math.min(innerHeight - 150, Math.max(10, y + 14))}px`,
    });
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Décris la correction…";
    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Annuler";
    const add = document.createElement("button");
    add.textContent = "Ajouter au panier";
    const send = document.createElement("button");
    send.className = "primary";
    send.textContent = "Envoyer";
    const finish = (sendNow: boolean | null) => {
      const instruction = textarea.value.trim();
      if (sendNow !== null && !instruction) { textarea.focus(); return; }
      bubble.remove();
      resolve(sendNow === null ? null : { instruction, send: sendNow });
    };
    cancel.addEventListener("click", () => finish(null));
    add.addEventListener("click", () => finish(false));
    send.addEventListener("click", () => finish(true));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish(null);
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) finish(false);
    });
    actions.append(cancel, add, send);
    bubble.append(textarea, actions);
    shadow.append(bubble);
    textarea.focus();
  });
}

document.addEventListener("mousemove", (event) => {
  if (!active) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target && target !== overlay) placeHighlight(target);
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
    projectId = await resolveProject();
    const answer = await askInstruction(event.clientX, event.clientY);
    if (!answer) return;
    const { instruction } = answer;
    const annotation = { ...inspectElement(element, { x: event.clientX, y: event.clientY }), instruction };
    const stored = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    const number = (stored.carts?.[projectId]?.length ?? 0) + 1;
    renderMarkers([...(stored.carts?.[projectId] ?? []), { ...annotation, number }]);
    const response = await chrome.runtime.sendMessage({ type: "ADD_ANNOTATION", projectId, annotation });
    if (response.error) {
      renderMarkers(stored.carts?.[projectId] ?? []);
      throw new Error(response.error);
    }
    if (answer.send) await chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  }
}, true);

chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (value: any) => void) => {
  if (message.type === "START_INSPECTION") start();
  if (message.type === "PAGE_INFO") sendResponse({
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    });
  if (message.type === "SYNC_MARKERS" && message.projectId === projectId) renderMarkers(message.annotations ?? []);
  if (message.type === "CLEAR_MARKERS" && (!projectId || message.projectId === projectId)) {
    for (const marker of markers.values()) marker.remove();
    markers.clear();
    markerAnnotations = [];
  }
});

addEventListener("scroll", repositionMarkers, { passive: true });
addEventListener("resize", repositionMarkers, { passive: true });
void restoreMarkers();
