import { useEffect, useId, useState } from 'react'

/** Laisse au flux le temps de se stabiliser : on ne rend pas un diagramme mi-écrit. */
const SETTLE_MS = 200

let loader: Promise<typeof import('mermaid').default> | null = null

function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** Import paresseux : mermaid (~500 Ko) n'est téléchargé qu'au premier diagramme. */
function loadMermaid() {
  if (!loader) {
    loader = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: token('--font-sans', 'sans-serif'),
        themeVariables: {
          background: token('--bg-input', '#282c34'),
          primaryColor: token('--bg-raised', '#2b2f38'),
          primaryTextColor: token('--text', '#e9e8ed'),
          primaryBorderColor: token('--accent-border', '#7d6bb8'),
          secondaryColor: token('--bg-overlay', '#323640'),
          tertiaryColor: token('--bg-panel', '#22252c'),
          lineColor: token('--text-faint', '#898691'),
          textColor: token('--text', '#e9e8ed'),
        },
      })
      return mermaid
    })
  }
  return loader
}

/** Rend un bloc ```mermaid en SVG ; retombe sur le code brut si invalide. */
export default function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const renderId = `mermaid-${useId().replace(/[^a-zA-Z0-9]/gu, '')}`

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      loadMermaid()
        .then(async (mermaid) => {
          // parse() valide sans toucher au DOM : évite les blocs d'erreur injectés.
          if (!(await mermaid.parse(chart, { suppressErrors: true }))) throw new Error('diagramme invalide')
          return mermaid.render(renderId, chart)
        })
        .then((result) => {
          if (cancelled) return
          setSvg(result.svg)
          setInvalid(false)
        })
        .catch(() => {
          if (cancelled) return
          setSvg(null)
          setInvalid(true)
        })
    }, SETTLE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [chart, renderId])

  if (svg === null) {
    return (
      <pre className={`mermaid-fallback ${invalid ? 'is-invalid' : ''}`}>
        <code>{chart}</code>
      </pre>
    )
  }
  return (
    <figure
      className="mermaid-figure"
      role="img"
      aria-label="Diagramme"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
