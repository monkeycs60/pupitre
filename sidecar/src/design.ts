/** Accès à Claude Design (claude.ai/design), embarqué dans une fenêtre Tauri.
 *
 * claude.ai refuse à l'entrée la signature d'user-agent de WebKitGTK — le
 * moteur de la webview Tauri sur Linux — parce que le couple `X11; Linux` +
 * `AppleWebKit` ne correspond à aucun navigateur grand public. Mesuré : un UA
 * WebKitGTK honnête reçoit un 403 `{"error":{"type":"forbidden"}}`, et un UA
 * qui se déclare Chrome franchit le filtre mais échoue ensuite en boucle sur le
 * challenge Cloudflare, dont le JavaScript teste le moteur réel et voit WebKit.
 * La seule combinaison qui passe les deux barrières annonce Safari sur macOS.
 *
 * ATTENTION — ce module ne sait PAS prédire ce que la webview obtiendra. Un
 * `fetch` depuis le sidecar reçoit un 403 quels que soient ses en-têtes, y
 * compris avec l'user-agent exact de la fenêtre : Cloudflare discrimine sur
 * l'empreinte TLS et HTTP/2, qu'aucun client non-navigateur ne peut imiter.
 * Un preflight qui conclurait « refusé » sur ce 403 bloquerait donc la fenêtre
 * en permanence, alors qu'elle fonctionne. La seule chose mesurable ici est
 * l'accessibilité réseau de claude.ai — c'est tout ce que la fonction rend.
 */

export const DESIGN_URL = "https://claude.ai/design/";

/** Doit rester identique à `DESIGN_USER_AGENT` dans `src-tauri/src/lib.rs`.
 *  `tests/design.test.ts` échoue si les deux chaînes divergent. */
export const DESIGN_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";

const PROBE_TIMEOUT_MS = 8_000;

export type DesignReachability =
  /** claude.ai a répondu quelque chose — y compris un 403, qui ne dit rien du
   *  sort de la vraie webview. La fenêtre a toutes ses chances. */
  | { reachable: true; status: number }
  /** Rien n'a répondu : hors ligne, DNS, coupure réseau. Ni la fenêtre ni le
   *  navigateur n'afficheront Claude Design. */
  | { reachable: false; message: string };

/** Vérifie que claude.ai répond, sans prétendre deviner le verdict du filtre
 *  d'entrée pour la webview. N'ouvre rien et ne lit jamais le corps. */
export async function probeDesignReachability(
  fetchImpl: typeof fetch = fetch,
): Promise<DesignReachability> {
  try {
    const response = await fetchImpl(DESIGN_URL, {
      method: "GET",
      headers: { "user-agent": DESIGN_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { reachable: true, status: response.status };
  } catch (error) {
    return {
      reachable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
