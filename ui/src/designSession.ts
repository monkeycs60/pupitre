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

/** L'URL si elle désigne une page Claude Design sur laquelle il est légitime de
 *  rouvrir la webview, `null` sinon.
 *
 *  Sert à ne mémoriser que des cibles saines. La valeur naît d'une navigation
 *  faite par une page distante : sans ce filtre, une redirection ferait rouvrir
 *  la webview n'importe où, avec l'user-agent falsifié de Pupitre. La règle est
 *  répétée dans `sidecar/src/design.ts` (avant persistance) et dans
 *  `src-tauri/src/lib.rs` (avant navigation). */
export function resumableDesignUrl(url: string | null | undefined): string | null {
  if (!url || url.length > 2_048) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'claude.ai') return null
  if (parsed.pathname !== '/design' && !parsed.pathname.startsWith('/design/')) return null
  return url
}
