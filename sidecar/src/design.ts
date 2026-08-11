/** Accès à Claude Design (claude.ai/design), embarqué dans une fenêtre Tauri.
 *
 * claude.ai refuse à l'entrée la signature d'user-agent de WebKitGTK — le
 * moteur de la webview Tauri sur Linux — parce que le couple `X11; Linux` +
 * `AppleWebKit` ne correspond à aucun navigateur grand public. Mesuré : un UA
 * WebKitGTK honnête reçoit un 403 `{"error":{"type":"forbidden"}}`, et un UA
 * qui se déclare Chrome franchit le filtre mais échoue ensuite en boucle sur le
 * challenge Cloudflare, dont le JavaScript teste le moteur réel et voit WebKit.
 *
 * La seule combinaison qui passe les deux barrières annonce Safari sur macOS :
 * le moteur promis est bien celui qui exécute la page. C'est un contournement
 * d'un filtre posé volontairement par Anthropic, donc il peut cesser de
 * fonctionner sans préavis — d'où le probe ci-dessous, qui permet à l'interface
 * de proposer le navigateur système au lieu d'afficher une fenêtre en erreur.
 */

export const DESIGN_URL = "https://claude.ai/design/";

/** Doit rester identique à `DESIGN_USER_AGENT` dans `src-tauri/src/lib.rs`.
 *  `tests/design.test.ts` échoue si les deux chaînes divergent. */
export const DESIGN_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";

const PROBE_TIMEOUT_MS = 8_000;

export type DesignAccess =
  | { ok: true; status: number }
  /** Le filtre d'entrée de claude.ai a rejeté l'user-agent : le repli
   *  navigateur est le seul chemin restant. */
  | { ok: false; reason: "ua-refused"; status: number }
  /** claude.ai répond, mais en erreur : panne côté Anthropic, pas un refus. */
  | { ok: false; reason: "unavailable"; status: number }
  /** Rien n'a répondu : machine hors ligne, DNS, coupure réseau. */
  | { ok: false; reason: "unreachable"; status: null; message: string };

/** Teste le verdict du filtre d'entrée de claude.ai sans ouvrir de fenêtre.
 *
 *  Aucun cookie n'est envoyé : une session absente produit une 302 vers la page
 *  marketing, ce qui suffit à prouver que l'user-agent est accepté. Seul le
 *  statut est lu, jamais le corps. */
export async function probeDesignAccess(
  fetchImpl: typeof fetch = fetch,
): Promise<DesignAccess> {
  let response: Response;
  try {
    response = await fetchImpl(DESIGN_URL, {
      method: "GET",
      headers: { "user-agent": DESIGN_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "unreachable",
      status: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 403) {
    return { ok: false, reason: "ua-refused", status: 403 };
  }
  if (response.status >= 400) {
    return { ok: false, reason: "unavailable", status: response.status };
  }
  return { ok: true, status: response.status };
}
