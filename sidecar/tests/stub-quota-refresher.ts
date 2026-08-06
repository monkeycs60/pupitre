import { QuotaRefresher } from "../src/quota-refresh";
import type { QuotaTracker } from "../src/quotas";

/**
 * Un rafraîchisseur de quotas inoffensif pour les tests : la vraie lecture
 * claude tape l'API Anthropic et la lecture codex parle à l'app-server. Aucun
 * test de serveur ne veut de l'un ni de l'autre — seul quota-refresh.test.ts
 * pilote les deux dépendances explicitement.
 */
export function stubQuotaRefresher(quotas: QuotaTracker): QuotaRefresher {
  return new QuotaRefresher(quotas, {
    readCodexRateLimits: async () => null,
    readClaudeUsage: async () => null,
  });
}
