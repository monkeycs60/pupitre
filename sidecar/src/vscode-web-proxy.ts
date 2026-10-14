import type { Server, ServerWebSocket } from "bun";
import { VSCODE_WEB_BASE, type VscodeWebService } from "./vscode-web";

export interface VscodeWebSocketData {
  channel: "vscode-web";
  path: string;
  host: string;
  upstream: WebSocket | null;
  pending: Array<string | Uint8Array<ArrayBuffer>>;
}

/**
 * Script ajouté à la page de VS Code : Ctrl+1 y revient au fil de la
 * conversation. Le panneau est une iframe d'une autre origine, dont Pupitre
 * ne reçoit pas les touches.
 */
const BRIDGE = `addEventListener('keydown', function (event) {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && (event.code === 'Digit1' || event.code === 'Numpad1')) {
    event.preventDefault(); event.stopPropagation();
    parent.postMessage({ type: 'pupitre:conversation' }, '*');
  }
}, true);`;

/** Le nonce vient de l'en-tête CSP du serveur VS Code, ou à défaut d'une balise script de la page. */
export function injectBridge(html: string, contentSecurityPolicy: string | null = null): string {
  const nonce = contentSecurityPolicy?.match(/'nonce-([^']+)'/)?.[1] ?? html.match(/<script nonce="([^"]+)"/)?.[1];
  if (!nonce || !html.includes("</head>")) return html;
  return html.replace("</head>", `<script nonce="${nonce}">${BRIDGE}</script></head>`);
}

export function isVscodeWebPath(pathname: string): boolean {
  return pathname === VSCODE_WEB_BASE || pathname.startsWith(`${VSCODE_WEB_BASE}/`);
}

/**
 * Relaie VS Code web sous la même origine que le sidecar : le jeton de
 * serve-web est ajouté ici et n'atteint jamais la page, et l'en-tête de
 * langue est retiré. serve-web choisit ses traductions d'après lui, et le
 * paquet français qu'il télécharge ne correspond pas à son build : tous les
 * libellés sortaient décalés.
 */
export async function proxyVscodeWeb(
  request: Request,
  service: VscodeWebService,
  server: Server<VscodeWebSocketData>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const data: VscodeWebSocketData = { channel: "vscode-web", path: `${url.pathname}${url.search}`, host, upstream: null, pending: [] };
    return server.upgrade(request, { data }) ? undefined : new Response("upgrade WebSocket refusé", { status: 400 });
  }
  const { port, token } = await service.ready();
  const headers = new Headers(request.headers);
  headers.delete("accept-language");
  headers.set("host", host);
  headers.set("cookie", [request.headers.get("cookie"), `vscode-tkn=${token}`].filter(Boolean).join("; "));
  const upstream = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  if (upstream.headers.get("content-type")?.includes("text/html")) {
    return new Response(injectBridge(await upstream.text(), upstream.headers.get("content-security-policy")), { status: upstream.status, headers: responseHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export function openVscodeWebSocket(socket: ServerWebSocket<VscodeWebSocketData>, service: VscodeWebService): void {
  void service.ready().then(({ port, token }) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${port}${socket.data.path}`, {
      headers: { cookie: `vscode-tkn=${token}`, host: socket.data.host },
    } as unknown as string[]);
    upstream.binaryType = "arraybuffer";
    upstream.onopen = () => {
      for (const message of socket.data.pending.splice(0)) upstream.send(message);
    };
    upstream.onmessage = (event) => socket.send(event.data as string | ArrayBuffer);
    upstream.onclose = () => socket.close();
    upstream.onerror = () => socket.close();
    socket.data.upstream = upstream;
  }).catch(() => socket.close());
}

export function relayToVscodeWeb(socket: ServerWebSocket<VscodeWebSocketData>, received: string | Uint8Array): void {
  const message = typeof received === "string" ? received : new Uint8Array(received);
  const upstream = socket.data.upstream;
  if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(message);
  else socket.data.pending.push(message);
}

export function closeVscodeWebSocket(socket: ServerWebSocket<VscodeWebSocketData>): void {
  socket.data.upstream?.close();
  socket.data.upstream = null;
}
