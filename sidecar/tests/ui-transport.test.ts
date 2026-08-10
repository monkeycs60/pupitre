import { expect, test } from "bun:test";
import {
  htmlDocumentExternalUrl,
  httpUrl,
  mediaUrl,
  webSocketUrl,
} from "../../ui/src/transport";

test("la webview Tauri appelle directement le sidecar de production", () => {
  expect(httpUrl("/api/health", "tauri:")).toBe("http://127.0.0.1:4820/api/health");
  expect(mediaUrl("capture.png", "tauri:")).toBe(
    "http://127.0.0.1:4820/media/capture.png",
  );
  expect(webSocketUrl("/ws?channel=quotas", {
    protocol: "tauri:",
    host: "localhost",
  })).toBe("ws://127.0.0.1:4820/ws?channel=quotas");
});

test("le développement web conserve les routes relatives et le proxy Vite", () => {
  expect(httpUrl("/api/health", "http:")).toBe("/api/health");
  expect(mediaUrl("une image.png", "http:")).toBe("/media/une%20image.png");
  expect(webSocketUrl("/ws?conversation=abc", {
    protocol: "http:",
    host: "localhost:5173",
  })).toBe("ws://localhost:5173/ws?conversation=abc");
});

test("la WebView Tauri en développement contourne le proxy WebSocket Vite", () => {
  expect(webSocketUrl("/ws?channel=fleet", {
    protocol: "http:",
    host: "localhost:5173",
  }, true)).toBe("ws://127.0.0.1:4820/ws?channel=fleet");
});

test("l'ouverture système reçoit une URL HTML absolue dans Tauri", () => {
  expect(htmlDocumentExternalUrl("doc-1", "secret", "http:", true)).toBe(
    "http://127.0.0.1:4820/api/documents/doc-1/content?token=secret",
  );
  expect(htmlDocumentExternalUrl("doc-1", "secret", "http:", false)).toBe(
    "/api/documents/doc-1/content?token=secret",
  );
});
