import { expect, test } from "bun:test";
import {
  DESIGN_URL,
  DESIGN_USER_AGENT,
  isResumableDesignUrl,
  probeDesignReachability,
} from "../src/design";

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

test("interroge claude.ai sans suivre les redirections ni lire le corps", async () => {
  const { calls, impl } = fakeFetch(() => new Response(null, { status: 200 }));

  expect(await probeDesignReachability(impl)).toEqual({
    reachable: true,
    status: 200,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(DESIGN_URL);
  expect(calls[0]!.init.redirect).toBe("manual");
});

test("compte un 403 comme joignable, pas comme un refus de la webview", async () => {
  // Un fetch depuis le sidecar reçoit un 403 même avec l'user-agent exact de la
  // fenêtre : Cloudflare discrimine sur l'empreinte TLS, hors de portée d'un
  // client non-navigateur. Conclure « refusé » ici bloquerait la fenêtre en
  // permanence alors qu'elle fonctionne — c'est le bug que ce test verrouille.
  const { impl } = fakeFetch(
    () => new Response('{"error":{"type":"forbidden"}}', { status: 403 }),
  );

  expect(await probeDesignReachability(impl)).toEqual({
    reachable: true,
    status: 403,
  });
});

test("signale une machine hors ligne", async () => {
  const { impl } = fakeFetch(() => {
    throw new TypeError("Unable to connect");
  });

  const reachability = await probeDesignReachability(impl);

  expect(reachability.reachable).toBe(false);
  if (reachability.reachable) throw new Error("joignabilité inattendue");
  expect(reachability.message).toContain("Unable to connect");
});

test("la fenêtre Tauri présente exactement le même user-agent et la même cible", async () => {
  // Garde anti-dérive : la webview ne se charge qu'avec cet user-agent précis,
  // et le bouton de repli doit ouvrir la même URL que la fenêtre. Les deux
  // constantes vivent dans des langages différents, donc rien d'autre que ce
  // test ne les tient ensemble.
  const rust = await Bun.file(
    new URL("../../src-tauri/src/lib.rs", import.meta.url),
  ).text();

  expect(rust).toContain(`"${DESIGN_USER_AGENT}"`);
  expect(rust).toContain(`"${DESIGN_URL}"`);
});

test("accepte de reprendre une page Claude Design", () => {
  expect(isResumableDesignUrl(DESIGN_URL)).toBe(true);
  expect(isResumableDesignUrl("https://claude.ai/design")).toBe(true);
  expect(isResumableDesignUrl(
    "https://claude.ai/design/019e2187-fb46-71f4-8546-559244c11de1",
  )).toBe(true);
});

test("refuse toute cible qui n'est pas une page Claude Design", () => {
  // La valeur vient d'une navigation faite par une page distante : sans ce
  // filtre, une redirection pourrait faire rouvrir la webview n'importe où,
  // avec l'user-agent falsifié de Pupitre.
  expect(isResumableDesignUrl("https://claude.ai/new")).toBe(false);
  expect(isResumableDesignUrl("https://claude.com/product/design")).toBe(false);
  expect(isResumableDesignUrl("https://evil.example/design/")).toBe(false);
  expect(isResumableDesignUrl("https://claude.ai.evil.example/design/")).toBe(false);
  expect(isResumableDesignUrl("http://claude.ai/design/")).toBe(false);
  expect(isResumableDesignUrl("javascript:alert(1)")).toBe(false);
  expect(isResumableDesignUrl("https://claude.ai/designs-autre")).toBe(false);
  expect(isResumableDesignUrl(null)).toBe(false);
  expect(isResumableDesignUrl(42)).toBe(false);
  expect(isResumableDesignUrl(`https://claude.ai/design/${"x".repeat(3_000)}`)).toBe(false);
});

test("la validation de reprise est répétée côté Rust", () => {
  // Rust ne fait pas confiance au frontend : si la garde disparaît de lib.rs,
  // une URL persistée frauduleuse serait ouverte sans contrôle.
  const rust = require("node:fs").readFileSync(
    new URL("../../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  ) as string;
  expect(rust).toContain("resumable_design_url");
  expect(rust).toContain('"claude.ai"');
  expect(rust).toContain('"/design"');
});
