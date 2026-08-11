import { expect, test } from "bun:test";
import { DESIGN_URL, DESIGN_USER_AGENT, probeDesignAccess } from "../src/design";

function fakeFetch(
  responder: (input: string, init: RequestInit) => Response | Promise<Response>,
): { calls: Array<{ url: string; init: RequestInit }>; impl: typeof fetch } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return await responder(url, init);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("interroge claude.ai avec l'user-agent Safari macOS et sans suivre les redirections", async () => {
  const { calls, impl } = fakeFetch(() => new Response(null, { status: 200 }));

  const access = await probeDesignAccess(impl);

  expect(access).toEqual({ ok: true, status: 200 });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(DESIGN_URL);
  const headers = new Headers(calls[0]!.init.headers);
  expect(headers.get("user-agent")).toBe(DESIGN_USER_AGENT);
  // Suivre la redirection téléchargerait la page marketing pour rien : le seul
  // fait mesuré est le verdict du filtre d'entrée de claude.ai.
  expect(calls[0]!.init.redirect).toBe("manual");
});

test("considère une redirection comme un accès accordé", async () => {
  // Sans cookie de session, claude.ai/design/ renvoie une 302 vers la page
  // marketing claude.com. Le filtre d'entrée a donc laissé passer la requête.
  const { impl } = fakeFetch(() => new Response(null, { status: 302 }));

  expect(await probeDesignAccess(impl)).toEqual({ ok: true, status: 302 });
});

test("signale un refus d'user-agent sur 403", async () => {
  const { impl } = fakeFetch(
    () => new Response('{"error":{"type":"forbidden"}}', { status: 403 }),
  );

  expect(await probeDesignAccess(impl)).toEqual({
    ok: false,
    reason: "ua-refused",
    status: 403,
  });
});

test("distingue une panne de claude.ai d'un refus d'user-agent", async () => {
  const { impl } = fakeFetch(() => new Response(null, { status: 503 }));

  expect(await probeDesignAccess(impl)).toEqual({
    ok: false,
    reason: "unavailable",
    status: 503,
  });
});

test("signale une machine hors ligne sans la confondre avec un refus", async () => {
  const { impl } = fakeFetch(() => {
    throw new TypeError("Unable to connect");
  });

  const access = await probeDesignAccess(impl);

  expect(access.ok).toBe(false);
  if (access.ok) throw new Error("accès inattendu");
  expect(access.reason).toBe("unreachable");
  expect(access.status).toBeNull();
});

test("la fenêtre Tauri présente exactement le même user-agent que le probe", async () => {
  // Garde anti-dérive : si les deux chaînes divergent, le probe validerait un
  // accès que la vraie webview se ferait refuser, et le repli ne partirait
  // jamais. Les deux constantes vivent dans des langages différents, donc rien
  // d'autre que ce test ne les tient ensemble.
  const rust = await Bun.file(
    new URL("../../src-tauri/src/lib.rs", import.meta.url),
  ).text();

  expect(rust).toContain(`"${DESIGN_USER_AGENT}"`);
  expect(rust).toContain(`"${DESIGN_URL}"`);
});
