/** Détection de session absente dans la webview Claude Design.
 *
 *  Sans cookie de session, `claude.ai/design/` redirige vers la page marketing
 *  `claude.com/product/design` — la webview affiche alors « Try Claude » au lieu
 *  de l'outil, sans qu'aucune erreur ne soit levée. C'est l'URL atterrie, lue
 *  côté Rust, qui trahit le problème. */

/** Vrai quand l'URL courante est la page marketing, donc qu'il faut se
 *  reconnecter.
 *
 *  Volontairement étroit : un flux OAuth passe par `accounts.google.com` et
 *  `claude.ai/login`, qui sont des étapes légitimes. Tout traiter comme une
 *  anomalie afficherait un avertissement en pleine connexion. */
export function needsDesignLogin(url: string | null | undefined): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.hostname === 'claude.com' && parsed.pathname.startsWith('/product')
}
