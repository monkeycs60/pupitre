import { addAnnotation, removeAnnotation } from "./cart";
import { PupitreClient } from "./client";
import type { Carts } from "./types";

interface StoredState {
  token?: string;
  port?: number;
  carts?: Carts;
  branches?: Record<string, string>;
  conversations?: Record<string, string>;
}

async function state(): Promise<StoredState> {
  return chrome.storage.local.get(["token", "port", "carts", "branches", "conversations"]);
}

async function client(): Promise<PupitreClient> {
  const stored = await state();
  if (!stored.token) throw new Error("Appaire l’extension depuis les réglages Pupitre.");
  return new PupitreClient(`http://127.0.0.1:${stored.port ?? 4820}`, stored.token);
}

async function cropScreenshot(dataUrl: string, rect: { left: number; top: number; width: number; height: number; devicePixelRatio: number }): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const ratio = rect.devicePixelRatio || 1;
  const padding = 24;
  const left = Math.max(0, Math.floor((rect.left - padding) * ratio));
  const top = Math.max(0, Math.floor((rect.top - padding) * ratio));
  const width = Math.max(1, Math.min(bitmap.width - left, Math.ceil((rect.width + padding * 2) * ratio)));
  const height = Math.max(1, Math.min(bitmap.height - top, Math.ceil((rect.height + padding * 2) * ratio)));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
  bitmap.close();
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

async function syncMarkers(projectId: string, annotations: unknown[]) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab: any) => tab.id).map((tab: any) =>
    chrome.tabs.sendMessage(tab.id, { type: "SYNC_MARKERS", projectId, annotations }).catch(() => undefined)));
}

chrome.commands.onCommand.addListener(async (command: string) => {
  if (command !== "start-inspection") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "START_INSPECTION" });
});

chrome.runtime.onMessage.addListener((message: any, sender: any, respond: (value: any) => void) => {
  void (async () => {
    if (message.type === "RESOLVE") return (await client()).resolve(message.origin, message.pathname);
    if (message.type === "DESTINATIONS") return (await client()).destinations(message.projectId);
    if (message.type === "ASSOCIATE") return (await client()).associate(message.origin, message.pathname, message.projectId);
    if (message.type === "GET_STATE") {
      const stored = await state();
      return { paired: Boolean(stored.token), port: stored.port ?? 4820, carts: stored.carts ?? {} };
    }
    if (message.type === "SAVE_CONNECTION") {
      await chrome.storage.local.set({ token: message.token.trim(), port: Number(message.port) || 4820 });
      return { ok: true };
    }
    if (message.type === "OPEN_POPUP") {
      await chrome.action.openPopup();
      return { ok: true };
    }
    if (message.type === "ADD_ANNOTATION") {
      const stored = await state();
      const screenshot = sender.tab?.windowId !== undefined
        ? await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" })
        : undefined;
      const crop = screenshot && message.annotation.captureRect
        ? await cropScreenshot(screenshot, message.annotation.captureRect)
        : undefined;
      const carts = addAnnotation(stored.carts ?? {}, message.projectId, {
        ...message.annotation,
        ...(crop ? { cropDataUrl: crop } : {}),
        ...(screenshot ? { viewportDataUrl: screenshot } : {}),
      });
      await chrome.storage.local.set({ carts });
      return { annotations: carts[message.projectId] };
    }
    if (message.type === "REMOVE_ANNOTATION") {
      const stored = await state();
      const carts = removeAnnotation(stored.carts ?? {}, message.projectId, message.number);
      await chrome.storage.local.set({ carts });
      await syncMarkers(message.projectId, carts[message.projectId] ?? []);
      return { annotations: carts[message.projectId] };
    }
    if (message.type === "SUBMIT") {
      const stored = await state();
      const annotations = stored.carts?.[message.projectId] ?? [];
      if (!annotations.length) throw new Error("Le panier est vide.");
      const submissionKey = `submission:${message.projectId}`;
      const existing = await chrome.storage.local.get(submissionKey);
      const submissionId = existing[submissionKey] ?? crypto.randomUUID();
      await chrome.storage.local.set({ [submissionKey]: submissionId });
      const result = await (await client()).submit({
        version: 1,
        submissionId,
        projectId: message.projectId,
        branch: message.branch,
        ...(message.conversationId ? { conversationId: message.conversationId } : {}),
        ...(message.generalInstruction ? { generalInstruction: message.generalInstruction } : {}),
        page: message.page,
        annotations,
      });
      const carts = { ...(stored.carts ?? {}), [message.projectId]: [] };
      await chrome.storage.local.remove(submissionKey);
      await chrome.storage.local.set({ carts });
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.filter((tab: any) => tab.id && (
        /^http:\/\/(?:[^/]*\.)?localhost(?::\d+)?\//u.test(tab.url ?? "")
        || /^http:\/\/127\.0\.0\.1(?::\d+)?\//u.test(tab.url ?? "")
      ))
        .map((tab: any) => chrome.tabs.sendMessage(tab.id, { type: "CLEAR_MARKERS", projectId: message.projectId }).catch(() => undefined)));
      return result;
    }
    throw new Error("Message inconnu");
  })().then(respond).catch((error) => respond({ error: error instanceof Error ? error.message : String(error) }));
  return true;
});
